package questions

import (
	"encoding/json"
	"testing"
	"xuetangx/internal/domain"
	"xuetangx/internal/platform/wire"
)

func TestAnswerNormalization(t *testing.T) {
	cases := []struct {
		content, source string
		expected        string
	}{{`{"Type":"Judgement"}`, `{"is_show_answer":true,"answer":[false]}`, "错误"}, {`{"Type":"SingleChoice","Options":[{"key":"0"}]}`, `{"is_show_answer":true,"answer":[0]}`, "0"}}
	for _, c := range cases {
		p := domain.Problem{Content: json.RawMessage(c.content)}
		source, _ := wire.Decode([]byte(c.source))
		a, ok := Extract(p, source)
		if !ok || a.Answer != c.expected {
			t.Fatalf("%+v %v", a, ok)
		}
	}
	p := domain.Problem{Content: json.RawMessage(`{"Type":"SingleChoice","Options":[{"key":"A"}]}`)}
	if _, ok := Extract(p, wire.Object{"is_show_answer": true, "my_answer": []any{"A"}}); ok {
		t.Fatal("user answer treated as standard")
	}
}
func TestLegacySerialization(t *testing.T) {
	raw := []byte(`{"z":"<标签>&\u2028","2":2,"1":1,"opts":[{"key":"A","value":"x"}],"small":1e-7,"large":1e21}`)
	got, e := stringify(raw, false)
	if e != nil {
		t.Fatal(e)
	}
	want := "{\"1\":1,\"2\":2,\"z\":\"<标签>&\u2028\",\"opts\":[{\"key\":\"A\",\"value\":\"x\"}],\"small\":1e-7,\"large\":1e+21}"
	if string(got) != want {
		t.Fatalf("got %s want %s", got, want)
	}
	p := domain.Problem{Content: json.RawMessage(`{"Type":"SingleChoice","Body":"<p>a</p>","Options":[{"key":"A","value":"0"}]}`)}
	other := domain.Problem{Content: json.RawMessage(`{"Options":[{"value":"0","key":"A"}],"Body":"<p>a</p>","Type":"SingleChoice"}`)}
	if Fingerprint(p) != Fingerprint(other) {
		t.Fatal("canonical hash depends on key order")
	}
	if !Matches(p, LegacyFingerprints(p)[0], "legacy") {
		t.Fatal("legacy match failed")
	}
}
func TestUnknownCountNotUnanswered(t *testing.T) {
	for _, raw := range []string{`{}`, `{"my_count":null}`, `{"my_count":false}`, `{"my_count":""}`} {
		if _, e := Count(domain.Problem{User: json.RawMessage(raw)}); e == nil {
			t.Fatal(raw)
		}
	}
}
