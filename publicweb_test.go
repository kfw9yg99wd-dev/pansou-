package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"
)

// Test-only fixture, never a deployment default.
const testJWTSecret = "T9j2-Q8f5-Y7a4-M6v3-Z1r0-U9w2-K8s5"

func TestPublicSettings(t *testing.T) {
	public := map[string]string{"PANSOU_LISTEN_HOST": "0.0.0.0", "AUTH_ENABLED": "true", "AUTH_USERS": "alice:A9-long-test-password!", "AUTH_JWT_SECRET": testJWTSecret}
	tests := []struct {
		name    string
		base    bool
		env     map[string]string
		wantErr bool
		address string
	}{
		{"local defaults", false, nil, false, "127.0.0.1:8888"},
		{"localhost pinned", false, map[string]string{"PANSOU_LISTEN_HOST": "localhost", "PORT": "9999"}, false, "127.0.0.1:9999"},
		{"IPv6 loopback", false, map[string]string{"PANSOU_LISTEN_HOST": "::1"}, false, "[::1]:8888"},
		{"public authenticated", true, nil, false, "0.0.0.0:8888"},
		{"disabled public", true, map[string]string{"AUTH_ENABLED": "false"}, true, ""},
		{"unset public", true, map[string]string{"AUTH_ENABLED": ""}, true, ""},
		{"IPv6 wildcard", false, map[string]string{"PANSOU_LISTEN_HOST": "::"}, true, ""},
		{"private LAN", false, map[string]string{"PANSOU_LISTEN_HOST": "192.168.1.3"}, true, ""},
		{"hostname rejected", false, map[string]string{"PANSOU_LISTEN_HOST": "example.com"}, true, ""},
		{"bad auth spelling", false, map[string]string{"AUTH_ENABLED": "TRUE"}, true, ""},
		{"empty users", true, map[string]string{"AUTH_USERS": ""}, true, ""},
		{"short password", true, map[string]string{"AUTH_USERS": "alice:short"}, true, ""},
		{"weak password", true, map[string]string{"AUTH_USERS": "alice:password123456"}, true, ""},
		{"malformed users", true, map[string]string{"AUTH_USERS": "alice:A9-long-test-password!,broken"}, true, ""},
		{"duplicate users", true, map[string]string{"AUTH_USERS": "alice:A9-long-test-password!,alice:B8-long-test-password!"}, true, ""},
		{"blank username", true, map[string]string{"AUTH_USERS": ":A9-long-test-password!"}, true, ""},
		{"missing secret", true, map[string]string{"AUTH_JWT_SECRET": ""}, true, ""},
		{"short secret", true, map[string]string{"AUTH_JWT_SECRET": "short"}, true, ""},
		{"fallback secret", true, map[string]string{"AUTH_JWT_SECRET": "pansou-default-secret-123456789012345"}, true, ""},
		{"repeated secret", true, map[string]string{"AUTH_JWT_SECRET": strings.Repeat("a", 32)}, true, ""},
		{"local auth needs explicit secret", false, map[string]string{"AUTH_ENABLED": "true", "AUTH_USERS": "alice:local"}, true, ""},
		{"local legacy password allowed", false, map[string]string{"AUTH_ENABLED": "true", "AUTH_USERS": "alice:local", "AUTH_JWT_SECRET": testJWTSecret}, false, "127.0.0.1:8888"},
		{"zero port", false, map[string]string{"PORT": "0"}, true, ""},
		{"large port", false, map[string]string{"PORT": "65536"}, true, ""},
		{"bad port", false, map[string]string{"PORT": "http"}, true, ""},
		{"allowed origins", true, map[string]string{"PANSOU_ALLOWED_ORIGINS": "https://one.example, http://localhost:3000"}, false, "0.0.0.0:8888"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			env := make(map[string]string)
			if tc.base {
				for k, v := range public {
					env[k] = v
				}
			}
			for k, v := range tc.env {
				env[k] = v
			}
			s, err := loadPublicSettings(func(k string) string { return env[k] })
			if (err != nil) != tc.wantErr {
				t.Fatalf("error = %v; want error %v", err, tc.wantErr)
			}
			if err == nil && s.address != tc.address {
				t.Errorf("address = %q, want %q", s.address, tc.address)
			}
			if err != nil && (strings.Contains(err.Error(), testJWTSecret) || strings.Contains(err.Error(), "A9-long-test-password!")) {
				t.Fatal("error exposed credentials")
			}
		})
	}
}

func TestOriginSyntax(t *testing.T) {
	for _, origin := range []string{"*", "https://*.example", "null", "", "https://a.example/", "https://u:password@a.example", "https://a.example?q=1", "https://a.example?", "https://a.example#", "https://a.example#x", "ftp://a.example", "https://a.example:bad", "https://a.example:70000", "https://a.example:", "https://[garbage]", "http://::1", "https://a..example", "https://a_example", "https://a.example https://b.example", "https://%61.example"} {
		t.Run(origin, func(t *testing.T) {
			if _, ok := parsePublicOrigin(origin); ok {
				t.Fatal("malformed origin accepted")
			}
			if origin != "" {
				_, err := loadPublicSettings(func(k string) string {
					if k == "PANSOU_ALLOWED_ORIGINS" {
						return origin
					}
					return ""
				})
				if err == nil {
					t.Fatal("malformed allowlist accepted")
				}
			}
		})
	}
	for _, origin := range []string{"http://localhost:8888", "https://example.com", "http://127.0.0.1", "https://[::1]:8888"} {
		if _, ok := parsePublicOrigin(origin); !ok {
			t.Errorf("valid origin rejected: %s", origin)
		}
	}
}

func testPublicHandler() http.Handler {
	assets := fstest.MapFS{
		"index.html":       {Data: []byte("<!doctype html><title>test UI</title>")},
		"app.js":           {Data: []byte("console.log('test');")},
		"styles.css":       {Data: []byte("body{color:black}")},
		"fonts/test.woff2": {Data: []byte("font")},
		".hidden":          {Data: []byte("do not serve")},
	}
	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*") // Mimic existing Gin middleware.
		w.Header().Set("X-Test-Backend", "yes")
		w.WriteHeader(http.StatusAccepted)
		io.WriteString(w, r.URL.Path)
	})
	return newPublicHandler(api, assets, publicSettings{allowedOrigins: map[string]bool{"https://allowed.example": true}})
}

func TestPublicRouting(t *testing.T) {
	h := testPublicHandler()
	for _, tc := range []struct {
		target  string
		status  int
		text    string
		backend bool
	}{
		{"/", 200, "test UI", false}, {"/web/", 200, "test UI", false}, {"/web", 200, "test UI", false},
		{"/index.html", 200, "test UI", false}, {"/app.js", 200, "console.log", false}, {"/web/app.js", 200, "console.log", false},
		{"/styles.css", 200, "color:black", false}, {"/fonts/test.woff2", 200, "font", false}, {"/library/recent", 200, "test UI", false},
		{"/nested/view/", 200, "test UI", false}, {"/web/nested/view/", 200, "test UI", false},
		{"/app.js/", 404, "", false}, {"/web/app.js/", 404, "", false}, {"/fonts/test.woff2/", 404, "", false},
		{"/missing.js", 404, "", false}, {"/missing.js/nested", 404, "", false}, {"/web/missing.css", 404, "", false},
		{"/fonts/", 404, "", false}, {"/fonts/missing", 404, "", false}, {"/assets/missing", 404, "", false},
		{"/.hidden", 404, "", false}, {"/web/.hidden", 404, "", false}, {"/../main.go", 404, "", false},
		{"/%2e%2e/main.go", 404, "", false}, {"/%252e%252e/main.go", 404, "", false}, {"/a%5cb", 404, "", false},
		{"//api/auth/login", 404, "", false}, {"/api/../index.html", 404, "", false},
		{"/api", 202, "/api", true}, {"/api/health", 202, "/api/health", true}, {"/api/missing.js", 202, "/api/missing.js", true},
		{"/qqpd/manage", 202, "/qqpd/manage", true}, {"/gying/manage", 202, "/gying/manage", true},
		{"/weibo/manage", 202, "/weibo/manage", true}, {"/panlian/manage", 202, "/panlian/manage", true}, {"/woniu/manage", 202, "/woniu/manage", true},
		{"/apiculture", 200, "test UI", false},
	} {
		t.Run(tc.target, func(t *testing.T) {
			w := httptest.NewRecorder()
			r := httptest.NewRequest("GET", tc.target, nil)
			h.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("status = %d, want %d", w.Code, tc.status)
			}
			if !strings.Contains(w.Body.String(), tc.text) {
				t.Errorf("body = %q", w.Body.String())
			}
			if got := w.Header().Get("X-Test-Backend") == "yes"; got != tc.backend {
				t.Errorf("backend = %v", got)
			}
		})
	}
}

func TestPublicOriginGate(t *testing.T) {
	h := testPublicHandler()
	for _, tc := range []struct {
		origin string
		status int
	}{
		{"http://example.com", 202}, {"https://example.com", 202}, {"https://allowed.example", 202},
		{"https://evil.example", 403}, {"null", 403}, {"https://user:password@example.com", 403}, {"http://example.com:81", 403}, {"https://allowed.example/", 403},
	} {
		t.Run(tc.origin, func(t *testing.T) {
			r := httptest.NewRequest("GET", "http://example.com/api/health", nil)
			r.Header.Set("Origin", tc.origin)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Errorf("status = %d", w.Code)
			}
			if tc.status == 403 && (w.Header().Get("Access-Control-Allow-Origin") != "" || w.Header().Get("X-Test-Backend") != "") {
				t.Fatal("rejected Origin reached backend")
			}
		})
	}
	r := httptest.NewRequest("GET", "/api/health", nil)
	r.Header["Origin"] = []string{"http://example.com", "https://evil.example"}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("multiple Origin values accepted")
	}
	settings := publicSettings{localUnauthenticated: true}
	for _, host := range []string{"localhost:8888", "127.0.0.1:8888", "[::1]:8888"} {
		r := httptest.NewRequest("GET", "/api/health", nil)
		r.Host = host
		if !originAllowed(r, settings) {
			t.Errorf("local Host rejected: %s", host)
		}
	}
	r = httptest.NewRequest("GET", "/api/health", nil)
	r.Host = "rebind.example"
	if originAllowed(r, settings) {
		t.Fatal("DNS rebinding Host accepted")
	}
}

func TestPublicSecurityHeadersAndMethods(t *testing.T) {
	h := testPublicHandler()
	for _, target := range []string{"/", "/app.js", "/api/health", "/missing.css"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		for key, value := range map[string]string{"X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer"} {
			if w.Header().Get(key) != value {
				t.Errorf("%s: missing %s", target, key)
			}
		}
		if target == "/" {
			csp := w.Header().Get("Content-Security-Policy")
			if !strings.Contains(csp, "font-src 'self'") || strings.Contains(csp, "unsafe-inline") || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("unsafe static headers")
			}
		}
		if target == "/api/health" && w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("API response cacheable")
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("HEAD", "/", nil))
	if w.Code != 200 || w.Body.Len() != 0 {
		t.Fatal("HEAD must not return body")
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "/", nil))
	if w.Code != 405 || w.Header().Get("Allow") != "GET, HEAD" {
		t.Fatal("static POST allowed")
	}
}

func TestPublicBodyLimit(t *testing.T) {
	h := testPublicHandler()
	for _, length := range []int64{-1, maxPublicBody + 1} {
		r := httptest.NewRequest("POST", "/api/search", strings.NewReader(strings.Repeat("a", maxPublicBody+1)))
		r.ContentLength = length
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 413 || w.Header().Get("X-Test-Backend") != "" {
			t.Fatalf("length %d: status %d", length, w.Code)
		}
	}
	r := httptest.NewRequest("POST", "/api/search", strings.NewReader(`{"kw":"test"}`))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 202 {
		t.Fatal("normal API body rejected")
	}
}

func TestPublicBackendRequestPreservation(t *testing.T) {
	const payload = `{"kw":"test","src":"plugin"}`
	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil || string(body) != payload || r.URL.RawQuery != "res=merge" || r.Header.Get("Authorization") != "Bearer test-token" {
			t.Error("adapter changed the API request")
		}
		w.WriteHeader(http.StatusNoContent)
	})
	h := newPublicHandler(api, fstest.MapFS{}, publicSettings{})
	r := httptest.NewRequest("POST", "/api/search?res=merge", strings.NewReader(payload))
	r.Header.Set("Authorization", "Bearer test-token")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusNoContent {
		t.Fatalf("status %d", w.Code)
	}
}

func TestPublicMissingIndexNeverListsDirectory(t *testing.T) {
	h := newPublicHandler(http.NotFoundHandler(), fstest.MapFS{"app.js": {Data: []byte("test")}}, publicSettings{})
	for _, target := range []string{"/", "/nested/route"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		if w.Code != 404 || strings.Contains(w.Body.String(), "app.js") {
			t.Fatal("directory listing exposed")
		}
	}
}

func TestPublicLoginThrottle(t *testing.T) {
	h := testPublicHandler()
	for i := 0; i < 11; i++ {
		r := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(`{}`))
		r.Header.Set("X-Forwarded-For", "192.0.2."+strconv.Itoa(i))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		want := 202
		if i == 10 {
			want = 429
		}
		if w.Code != want {
			t.Fatalf("attempt %d: status %d", i, w.Code)
		}
	}
	l := &loginLimiter{peers: make(map[string]loginWindow)}
	now := time.Now()
	for i := 0; i < 1024; i++ {
		if !l.allow(strconv.Itoa(i), now) {
			t.Fatal("bucket rejected early")
		}
	}
	if l.allow("overflow", now) || len(l.peers) != 1024 {
		t.Fatal("limiter unbounded")
	}
	if !l.allow("new", now.Add(time.Minute)) {
		t.Fatal("expired buckets not reclaimed")
	}
}

func TestPublicLoginThrottleConcurrent(t *testing.T) {
	l := &loginLimiter{peers: make(map[string]loginWindow)}
	var wg sync.WaitGroup
	var accepted atomic.Int32
	now := time.Now()
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if l.allow("same-peer", now) {
				accepted.Add(1)
			}
		}()
	}
	wg.Wait()
	if accepted.Load() != 10 {
		t.Fatalf("accepted %d attempts", accepted.Load())
	}
}
