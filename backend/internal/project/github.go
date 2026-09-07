package project

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// GitHubRepoInfo holds key metadata extracted from the GitHub API.
type GitHubRepoInfo struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Language    string   `json:"language"`
	Topics      []string `json:"topics"`
	Stars       int      `json:"stargazers_count"`
	Readme      string   `json:"readme"`
}

type ghRepo struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Language    string   `json:"language"`
	Topics      []string `json:"topics"`
	Stars       int      `json:"stargazers_count"`
}

type ghReadme struct {
	Content  string `json:"content"`
	Encoding string `json:"encoding"`
}

// parseGitHubURL extracts owner/repo from common GitHub URL patterns.
func parseGitHubURL(raw string) (owner, repo string, err error) {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimSuffix(raw, "/")

	re := regexp.MustCompile(`github\.com/([^/]+)/([^/]+)`)
	m := re.FindStringSubmatch(raw)
	if len(m) < 3 {
		return "", "", fmt.Errorf("invalid GitHub URL: %s", raw)
	}
	owner = m[1]
	repo = strings.TrimSuffix(m[2], ".git")
	return owner, repo, nil
}

const maxReadmeChars = 8000

// readmeFileNames are tried in order when fetching README via raw URL.
var readmeFileNames = []string{"README.md", "readme.md", "Readme.md", "README", "README.txt"}

// FetchRepoInfo fetches repo metadata and README for a GitHub project.
//
// Strategy (avoids API rate limits for unauthenticated requests):
//   - README: fetched via raw.githubusercontent.com (no auth, no rate limit).
//   - Metadata: if a GitHub token is provided, fetched via the API for richer info;
//     otherwise, only owner/repo are extracted from the URL (no API call).
func FetchRepoInfo(githubURL string, token string) (*GitHubRepoInfo, error) {
	owner, repo, err := parseGitHubURL(githubURL)
	if err != nil {
		return nil, err
	}

	httpClient := &http.Client{Timeout: 15 * time.Second}

	// 1. Metadata: try API if token available, else just fill from URL.
	info := &GitHubRepoInfo{
		Name: owner + "/" + repo,
	}
	if token != "" {
		repoURL := fmt.Sprintf("https://api.github.com/repos/%s/%s", owner, repo)
		repoData, err := ghGet(httpClient, repoURL, token)
		if err == nil {
			var gh ghRepo
			if json.Unmarshal(repoData, &gh) == nil {
				info.Name = gh.Name
				info.Description = gh.Description
				info.Language = gh.Language
				info.Topics = gh.Topics
				info.Stars = gh.Stars
			}
		}
		// Non-fatal: metadata is optional, README matters more.
	}

	// 2. README: fetch via raw.githubusercontent.com (no auth needed, no rate limit).
	//    Try several common filenames; first successful one wins.
	info.Readme = fetchReadmeRaw(httpClient, owner, repo)

	return info, nil
}

// fetchReadmeRaw tries to download README from raw.githubusercontent.com.
func fetchReadmeRaw(client *http.Client, owner, repo string) string {
	// Try default branch first (main/master), then common README file names.
	for _, branch := range []string{"main", "master"} {
		for _, name := range readmeFileNames {
			url := fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/%s/%s", owner, repo, branch, name)
			body, err := plainGet(client, url)
			if err == nil && len(body) > 100 {
				text := string(body)
				if len(text) > maxReadmeChars {
					text = text[:maxReadmeChars] + "\n\n... (truncated)"
				}
				return text
			}
		}
	}
	return ""
}

// ghGet performs a GET with GitHub API headers (for /repos/... endpoints).
func ghGet(client *http.Client, url string, token string) ([]byte, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github.v3+json")
	req.Header.Set("User-Agent", "interview-assistant-bot")
	if token != "" {
		req.Header.Set("Authorization", "token "+token)
	}
	return doHTTP(client, req)
}

// plainGet performs a plain GET (for raw.githubusercontent.com).
func plainGet(client *http.Client, url string) ([]byte, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "interview-assistant-bot")
	return doHTTP(client, req)
}

func doHTTP(client *http.Client, req *http.Request) ([]byte, error) {
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("HTTP %s returned %d: %s", req.URL, resp.StatusCode, string(body))
	}
	return io.ReadAll(resp.Body)
}
