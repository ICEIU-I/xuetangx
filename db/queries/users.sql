-- name: FindUser :one
SELECT id,email,password_hash,verified,disabled,admin,created_at FROM users WHERE lower(email)=lower($1);

-- name: GetUser :one
SELECT id,email,password_hash,verified,disabled,admin,created_at FROM users WHERE id=$1;

-- name: ListUsers :many
SELECT id,email,verified,disabled,admin,created_at FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2;

-- name: CountPendingOperations :one
SELECT count(*) FROM operations WHERE state IN ('unknown','pending');
