package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestSearchHandlerRejectsBlankKeywords(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/api/search", SearchHandler)
	router.POST("/api/search", SearchHandler)
	for _, tc := range []struct{ name, method, target, body string }{
		{"missing POST keyword", "POST", "/api/search", `{}`},
		{"empty POST keyword", "POST", "/api/search", `{"kw":""}`},
		{"whitespace POST keyword", "POST", "/api/search", `{"kw":" \t\n\u3000 "}`},
		{"missing GET keyword", "GET", "/api/search", ""},
		{"whitespace GET keyword", "GET", "/api/search?kw=%20%09%E3%80%80", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(tc.method, tc.target, strings.NewReader(tc.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "关键词不能为空") {
				t.Fatalf("expected early keyword rejection, got %d %s", response.Code, response.Body.String())
			}
		})
	}
}
