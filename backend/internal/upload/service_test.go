package upload

import (
	"testing"
)

func TestValidateUpload(t *testing.T) {
	cases := []struct {
		name        string
		kind        string
		filename    string
		contentType string
		size        int64
		wantErr     bool
	}{
		{"resume pdf ok", "resume", "a.pdf", "application/pdf", 1024, false},
		{"jd txt ok", "jd", "b.txt", "text/plain", 1024, false},
		{"bad kind", "other", "a.pdf", "application/pdf", 1024, true},
		{"bad ext", "resume", "a.exe", "application/octet-stream", 1024, true},
		{"too big", "resume", "a.pdf", "application/pdf", 11 * 1024 * 1024, true},
		{"empty filename", "resume", "", "application/pdf", 1024, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateUpload(tc.kind, tc.filename, tc.contentType, tc.size)
			if (err != nil) != tc.wantErr {
				t.Fatalf("validateUpload(%q,%q,%q,%d) err=%v wantErr=%v", tc.kind, tc.filename, tc.contentType, tc.size, err, tc.wantErr)
			}
		})
	}
}
