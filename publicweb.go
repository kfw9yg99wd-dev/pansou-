package main

import (
	"bytes"
	"embed"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

//go:embed web
var publicWeb embed.FS

const maxPublicBody = 1 << 20 // One MiB, including chunked request bodies.

type publicSettings struct {
	address              string
	localUnauthenticated bool
	allowedOrigins       map[string]bool
}

func fsForPublicWeb() (fs.FS, error) { return fs.Sub(publicWeb, "web") }

// Only literal addresses (or localhost, pinned to 127.0.0.1) are accepted:
// deciding whether authentication is required must not depend on mutable DNS.
func loadPublicSettings(getenv func(string) string) (publicSettings, error) {
	s := publicSettings{allowedOrigins: make(map[string]bool)}
	host := getenv("PANSOU_LISTEN_HOST")
	if host == "" || host == "localhost" {
		host = "127.0.0.1"
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return s, errors.New("PANSOU_LISTEN_HOST must be a literal IP address or localhost")
	}
	port := getenv("PORT")
	if port == "" {
		port = "8888"
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		return s, errors.New("PORT must be between 1 and 65535")
	}
	s.address = net.JoinHostPort(host, port)
	auth := getenv("AUTH_ENABLED")
	if auth != "" && auth != "true" && auth != "false" && auth != "1" && auth != "0" {
		return s, errors.New("AUTH_ENABLED must be true, false, 1 or 0")
	}
	enabled := auth == "true" || auth == "1"
	s.localUnauthenticated = ip.IsLoopback() && !enabled
	if !ip.IsLoopback() && !enabled {
		return s, errors.New("non-loopback listeners require AUTH_ENABLED=true")
	}
	if enabled {
		secret := getenv("AUTH_JWT_SECRET")
		if utf8.RuneCountInString(secret) < 32 || strings.TrimSpace(secret) != secret || predictableCredential(secret) {
			return s, errors.New("AUTH_JWT_SECRET must be explicitly set to at least 32 unpredictable characters")
		}
		users := getenv("AUTH_USERS")
		if strings.TrimSpace(users) == "" {
			return s, errors.New("AUTH_USERS must contain at least one user")
		}
		seen := make(map[string]bool)
		for _, pair := range strings.Split(users, ",") {
			parts := strings.SplitN(pair, ":", 2)
			if len(parts) != 2 {
				return s, errors.New("AUTH_USERS must use username:password pairs")
			}
			name, password := strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
			if name == "" || password == "" || seen[name] {
				return s, errors.New("AUTH_USERS contains an empty or duplicate entry")
			}
			seen[name] = true
			if !ip.IsLoopback() && (utf8.RuneCountInString(password) < 12 || predictableCredential(password) || strings.EqualFold(name, password)) {
				return s, errors.New("public AUTH_USERS passwords must have at least 12 unpredictable characters")
			}
		}
	}
	if raw := getenv("PANSOU_ALLOWED_ORIGINS"); raw != "" {
		for _, item := range strings.Split(raw, ",") {
			origin := strings.TrimSpace(item)
			if _, ok := parsePublicOrigin(origin); !ok {
				return s, errors.New("PANSOU_ALLOWED_ORIGINS requires exact http(s) origins without paths, credentials or wildcards")
			}
			s.allowedOrigins[origin] = true
		}
	}
	return s, nil
}

// This catches common placeholders, not entropy. Operators must generate random
// secrets/passwords; no deterministic validator can prove unpredictability.
func predictableCredential(value string) bool {
	lower := strings.ToLower(value)
	for _, prefix := range []string{"pansou-default-secret", "change-me", "changeme", "replace-me", "replace_me", "your-secret", "your-jwt", "password", "123456789", "0123456789", "abcdefghijklmnopqrstuvwxyz"} {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	distinct := make(map[rune]bool)
	for _, r := range value {
		distinct[r] = true
	}
	return len(distinct) < 6
}

func parsePublicOrigin(origin string) (*url.URL, bool) {
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Opaque != "" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.ContainsAny(origin, "*\\#%\t\r\n ") {
		return nil, false
	}
	host := u.Hostname()
	if host == "" {
		return nil, false
	}
	if strings.Contains(host, ":") {
		if net.ParseIP(host) == nil || !strings.HasPrefix(u.Host, "[") {
			return nil, false
		}
	} else {
		if strings.ContainsAny(u.Host, "[]") || len(host) > 253 {
			return nil, false
		}
		for _, label := range strings.Split(strings.TrimSuffix(host, "."), ".") {
			if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
				return nil, false
			}
			for _, c := range label {
				if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-') {
					return nil, false
				}
			}
		}
	}
	if strings.HasSuffix(u.Host, ":") {
		return nil, false
	}
	if port := u.Port(); port != "" {
		p, err := strconv.Atoi(port)
		if err != nil || p < 1 || p > 65535 {
			return nil, false
		}
	}
	return u, true
}

func originAllowed(r *http.Request, s publicSettings) bool {
	// Prevent DNS rebinding from turning an unauthenticated loopback service
	// into an API on an attacker-controlled hostname. Ignore proxy headers.
	if s.localUnauthenticated {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		host = strings.Trim(host, "[]")
		if !strings.EqualFold(host, "localhost") && !net.ParseIP(host).IsLoopback() {
			return false
		}
	}
	origins, present := r.Header["Origin"]
	if !present {
		return true
	} // CLI clients and ordinary same-origin navigation.
	if len(origins) != 1 {
		return false
	}
	u, ok := parsePublicOrigin(origins[0])
	if !ok {
		return false
	}
	// The external scheme may be HTTPS at a reverse proxy. Do not trust
	// X-Forwarded-Host: compare to the actual Host passed by the proxy.
	return strings.EqualFold(u.Host, r.Host) || s.allowedOrigins[origins[0]]
}

func backendPath(p string) bool {
	for _, prefix := range []string{"/api", "/qqpd", "/gying", "/weibo", "/panlian", "/woniu"} {
		if p == prefix || strings.HasPrefix(p, prefix+"/") {
			return true
		}
	}
	return false
}

func safePublicPath(p string) bool {
	if !strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\\%\x00") || strings.Contains(p, "//") {
		return false
	}
	for _, r := range p {
		if r < 32 || r == 127 {
			return false
		}
	}
	for _, segment := range strings.Split(p, "/") {
		if strings.HasPrefix(segment, ".") {
			return false
		}
	}
	return true
}

func newPublicHandler(api http.Handler, assets fs.FS, settings publicSettings) http.Handler {
	files := http.FileServer(http.FS(assets))
	limiter := &loginLimiter{peers: make(map[string]loginWindow)}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Add("Vary", "Origin")
		if !originAllowed(r, settings) {
			http.Error(w, "Origin not allowed", http.StatusForbidden)
			return
		}
		if !safePublicPath(r.URL.Path) {
			http.NotFound(w, r)
			return
		}
		if backendPath(r.URL.Path) {
			w.Header().Set("Cache-Control", "no-store")
			if r.Method == http.MethodPost && strings.TrimSuffix(r.URL.Path, "/") == "/api/auth/login" {
				peer, _, err := net.SplitHostPort(r.RemoteAddr)
				if err != nil {
					peer = r.RemoteAddr
				}
				if !limiter.allow(peer, time.Now()) {
					w.Header().Set("Retry-After", "60")
					http.Error(w, "Too many login attempts", http.StatusTooManyRequests)
					return
				}
			}
			if r.Body != nil {
				if r.ContentLength > maxPublicBody {
					http.Error(w, "Request body too large", http.StatusRequestEntityTooLarge)
					return
				}
				body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxPublicBody))
				r.Body.Close()
				if err != nil {
					var oversized *http.MaxBytesError
					if errors.As(err, &oversized) {
						http.Error(w, "Request body too large", http.StatusRequestEntityTooLarge)
					} else {
						http.Error(w, "Invalid request body", http.StatusBadRequest)
					}
					return
				}
				r.Body = io.NopCloser(bytes.NewReader(body))
			}
			api.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/")
		// Both /app.js and /web/app.js address the same embedded file.
		name = strings.TrimPrefix(name, "web/")
		// fs.ValidPath rejects trailing slashes. Normalize UI routes before Stat,
		// but never reinterpret /app.js/ as a real static file.
		if strings.HasSuffix(name, "/") {
			name = strings.TrimSuffix(name, "/")
			if strings.Contains(name, ".") {
				http.NotFound(w, r)
				return
			}
		}
		if name == "" || name == "web" {
			name = "index.html"
		}
		info, err := fs.Stat(assets, name)
		if err == nil && info.IsDir() {
			http.NotFound(w, r)
			return
		}
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) || strings.Contains(name, ".") || strings.HasPrefix(name, "fonts/") || strings.HasPrefix(name, "assets/") {
				http.NotFound(w, r)
				return
			}
			name = "index.html" // Only extension-less UI routes receive the SPA.
			if index, err := fs.Stat(assets, name); err != nil || index.IsDir() {
				http.NotFound(w, r)
				return
			}
		}
		request := r.Clone(r.Context())
		request.URL.Path = "/" + name
		request.URL.RawPath = ""
		w.Header().Set("Cache-Control", "public, max-age=3600")
		if name == "index.html" {
			// FileServer redirects /index.html to ./; serve its directory index.
			request.URL.Path = "/"
			w.Header().Set("Cache-Control", "no-store")
		}
		files.ServeHTTP(w, request)
	})
}

type loginWindow struct {
	start time.Time
	count int
}
type loginLimiter struct {
	mu    sync.Mutex
	peers map[string]loginWindow
}

// Ten attempts per minute per TCP peer; never trust spoofable forwarding
// headers. Reverse proxies share a bucket. Memory is capped at 1024 peers.
func (l *loginLimiter) allow(peer string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	window, exists := l.peers[peer]
	if exists && now.Sub(window.start) < time.Minute {
		if window.count >= 10 {
			return false
		}
		window.count++
		l.peers[peer] = window
		return true
	}
	for key, item := range l.peers {
		if now.Sub(item.start) >= time.Minute {
			delete(l.peers, key)
		}
	}
	if len(l.peers) >= 1024 {
		return false
	}
	l.peers[peer] = loginWindow{start: now, count: 1}
	return true
}
