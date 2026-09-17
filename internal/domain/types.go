package domain

import "encoding/json"

type User struct {
	ID       string `json:"id"`
	Email    string `json:"email"`
	Verified bool   `json:"verified"`
	Disabled bool   `json:"disabled"`
	Admin    bool   `json:"admin"`
}
type Account struct {
	ID          string `json:"id"`
	Owner       string `json:"-"`
	UserID      int64  `json:"userId"`
	Role        string `json:"role"`
	Name        string `json:"name"`
	Connected   bool   `json:"connected"`
	ConnectedAt int64  `json:"connectedAt"`
	Revision    int64  `json:"-"`
}
type Course struct {
	ID          string `json:"-"`
	ClassroomID int64  `json:"classroomId"`
	Sign        string `json:"sign"`
	CourseSign  string `json:"courseSign"`
	Title       string `json:"title"`
	URL         string `json:"url"`
}
type Unit struct {
	ID       int64   `json:"id"`
	Kind     string  `json:"kind"`
	LeafType int     `json:"leafType"`
	Title    string  `json:"title"`
	Progress float64 `json:"progress"`
	Locked   bool    `json:"locked"`
}
type Problem struct {
	ID      int64           `json:"problem_id"`
	Index   int             `json:"index"`
	Content json.RawMessage `json:"content"`
	User    json.RawMessage `json:"user"`
}
type Exercise struct {
	LeafID     int64     `json:"leafId"`
	Title      string    `json:"title"`
	ExerciseID int64     `json:"exerciseId"`
	SKUID      int64     `json:"skuId"`
	Problems   []Problem `json:"problems"`
	Error      string    `json:"error,omitempty"`
}
type Inventory struct {
	Course    Course     `json:"course"`
	Units     []Unit     `json:"units"`
	Exercises []Exercise `json:"exercises"`
}
type Answer struct {
	Type     string              `json:"type"`
	Answer   string              `json:"answer,omitempty"`
	Answers  []string            `json:"answers,omitempty"`
	Accepted map[string][]string `json:"accepted_answers,omitempty"`
}
type Item struct {
	UnitID    int64  `json:"unitId"`
	ProblemID int64  `json:"problemId,omitempty"`
	Title     string `json:"title,omitempty"`
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
}
type Module struct {
	Status        string `json:"status"`
	Message       string `json:"message"`
	Role          string `json:"role,omitempty"`
	Total         int    `json:"total"`
	Processed     int    `json:"processed"`
	Completed     int    `json:"completed"`
	Skipped       int    `json:"skipped"`
	Failed        int    `json:"failed"`
	Captured      int    `json:"captured"`
	WrongExisting int    `json:"wrongExisting"`
	Generation    int64  `json:"-"`
	Restarts      int    `json:"-"`
	Results       []Item `json:"results"`
}
type Coverage struct {
	Total    int `json:"total"`
	Captured int `json:"captured"`
	Missing  int `json:"missing"`
}
type Log struct {
	TS      int64  `json:"ts"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
}
type Job struct {
	ID               string             `json:"id"`
	Owner            string             `json:"-"`
	AccountID        string             `json:"-"`
	PrimaryID        int64              `json:"primaryId"`
	Course           Course             `json:"course"`
	Status           string             `json:"status"`
	Concurrency      int                `json:"concurrency"`
	SubmitUnanswered bool               `json:"submitUnanswered"`
	Targets          []string           `json:"targets"`
	UnitID           int64              `json:"unitId,omitempty"`
	Revision         int64              `json:"revision"`
	CreatedAt        int64              `json:"createdAt"`
	UpdatedAt        int64              `json:"updatedAt"`
	Requested        []string           `json:"requested"`
	Modules          map[string]*Module `json:"modules"`
	Coverage         Coverage           `json:"coverage"`
	Logs             []Log              `json:"logs"`
}
type Start struct {
	CourseURL        string   `json:"courseUrl"`
	Modules          []string `json:"modules"`
	Concurrency      int      `json:"concurrency"`
	SubmitUnanswered *bool    `json:"submitUnanswered"`
	Targets          []string `json:"targets"`
	UnitID           int64    `json:"unitId"`
}
