package core

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// Wire types for POST {base}/v1/systemone — the TypeSafe System One API.
// Mirrors @typesafe-ai/sdk's SystemOneRequestPayload/SystemOneResult.

// Question is one named question: type "noul" | "choice" | "score".
// Instructions is always emitted (null allowed); Criteria omitted when nil.
type Question struct {
	Type         string `json:"type"`
	Instructions any    `json:"instructions"`
	Criteria     any    `json:"criteria,omitempty"`
}

// Noul builds a yes/no question. instructions may be a string or an object
// (extra keys like candidate_result ride along verbatim, as in the TS code).
func Noul(instructions any) Question {
	return Question{Type: "noul", Instructions: instructions}
}

// Choice builds a pick-between-labels question; criteria maps label →
// description (null allowed).
func Choice(instructions any, criteria map[string]any) Question {
	return Question{Type: "choice", Instructions: instructions, Criteria: criteria}
}

type SystemOneRequest struct {
	State     any                 `json:"state"`
	Questions map[string]Question `json:"questions"`
	Model     string              `json:"model"`
}

// Answer is the union of noul/choice/score answer shapes; Type discriminates.
type Answer struct {
	Type          string             `json:"type"`
	Noul          float64            `json:"noul"`
	Choice        string             `json:"choice"`
	Confidence    float64            `json:"confidence"`
	Probabilities map[string]float64 `json:"probabilities"`
}

func (a *Answer) IsNoul() bool   { return a != nil && a.Type == "noul" }
func (a *Answer) IsChoice() bool { return a != nil && a.Type == "choice" }

type SystemOneResult struct {
	Model   string            `json:"model"`
	Answers map[string]Answer `json:"answers"`
	Usage   Usage             `json:"usage"`
}

// HTTPAsker returns an Asker that posts to the System One REST endpoint —
// the Go replacement for TypeSafeClient.systemOne. apiKey defaults to
// $TYPESAFE_API_KEY, base to $TYPESAFE_BASE_URL then https://api.typesafe.ai,
// model to $TYPESAFE_DEFAULT_MODEL then jev-latest.
func HTTPAsker(apiKey, base, model string, client *http.Client) Asker {
	if apiKey == "" {
		apiKey = os.Getenv("TYPESAFE_API_KEY")
	}
	if base == "" {
		base = os.Getenv("TYPESAFE_BASE_URL")
	}
	if base == "" {
		base = "https://api.typesafe.ai"
	}
	if model == "" {
		model = os.Getenv("TYPESAFE_DEFAULT_MODEL")
	}
	if model == "" {
		model = "jev-latest"
	}
	if client == nil {
		client = &http.Client{Timeout: 120 * time.Second}
	}
	return func(ctx context.Context, req *SystemOneRequest) (*SystemOneResult, error) {
		payload := *req
		if payload.Model == "" {
			payload.Model = model
		}
		body, err := json.Marshal(&payload)
		if err != nil {
			return nil, fmt.Errorf("encode request: %w", err)
		}
		hreq, err := http.NewRequestWithContext(ctx, http.MethodPost,
			strings.TrimRight(base, "/")+"/v1/systemone", bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		hreq.Header.Set("Content-Type", "application/json")
		hreq.Header.Set("Authorization", "Bearer "+apiKey)
		res, err := client.Do(hreq)
		if err != nil {
			return nil, err
		}
		defer res.Body.Close()
		data, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
		if err != nil {
			return nil, err
		}
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			return nil, fmt.Errorf("systemone %s: %s", res.Status, excerpt(data))
		}
		var out SystemOneResult
		if err := json.Unmarshal(data, &out); err != nil {
			return nil, fmt.Errorf("decode result: %w", err)
		}
		return &out, nil
	}
}

func excerpt(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}
