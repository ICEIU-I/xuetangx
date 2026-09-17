package process

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"xuetangx/internal/domain"
	"xuetangx/internal/learning"
	"xuetangx/internal/platform"
	"xuetangx/internal/platform/wire"
)

func TestWorkerEntrypoint(t *testing.T) {
	if os.Args[len(os.Args)-1] != "worker" {
		return
	}
	if os.Getenv("DATABASE_URL") != "" || os.Getenv("COOKIE") != "" {
		os.Exit(3)
	}
	if e := Worker(os.Stdin, os.Stdout); e != nil {
		os.Exit(2)
	}
	os.Exit(0)
}
func TestRealWorkerRPCAndSecretEnvironment(t *testing.T) {
	t.Setenv("DATABASE_URL", "must-not-inherit")
	t.Setenv("COOKIE", "must-not-inherit")
	host := Host{Executable: os.Args[0], Args: []string{"-test.run=^TestWorkerEntrypoint$", "--", "worker"}}
	completed := false
	items := 0
	result, e := host.Run(context.Background(), 7, learning.Input{Kind: "article", Concurrency: 3, Course: domain.Course{ClassroomID: 12, Sign: "s"}, Units: []domain.Unit{{ID: 34, Kind: "article", LeafType: 3}}}, func(_ context.Context, _ string, p json.RawMessage) (any, error) {
		var args struct {
			Endpoint string `json:"endpoint"`
		}
		json.Unmarshal(p, &args)
		data := wire.Object{"id": 34, "classroom_id": 12, "leaf_type": 3, "sku_id": 9, "finish": completed}
		if strings.Contains(args.Endpoint, "user_article_finish") {
			completed = true
			data = wire.Object{}
		}
		return platform.Response{Status: 200, JSON: wire.Object{"success": true, "data": data}}, nil
	}, func(p learning.Progress) error {
		if p.Item != nil && p.Item.Status == "completed" {
			items++
		}
		return nil
	}, nil)
	if e != nil || result.Status != "done" || items != 1 {
		t.Fatal(result, items, e)
	}
}
