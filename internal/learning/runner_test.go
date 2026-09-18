package learning

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestPoolCancelsWaitingSiblingOnFatalError(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	waiting := make(chan struct{})
	fatal := errors.New("account expired")
	got := pool(ctx, 2, 2, func(child context.Context, index int) error {
		if index == 0 {
			close(waiting)
			<-child.Done()
			return child.Err()
		}
		<-waiting
		return fatal
	})
	if !errors.Is(got, fatal) || ctx.Err() != nil {
		t.Fatalf("waiting sibling was not cancelled promptly: %v, parent=%v", got, ctx.Err())
	}
}
