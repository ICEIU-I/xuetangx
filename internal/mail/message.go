package mail

import (
	"bytes"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"net/textproto"
	"strings"
	"time"

	"github.com/google/uuid"
)

func (s SMTP) message(host, to, subject, plain string) (string, error) {
	return s.richMessage(host, to, subject, plain, "")
}

// richMessage uses email-safe MIME rather than sending HTML as plain text.
// The plain part always comes first and remains readable without HTML support.
func (s SMTP) richMessage(host, to, subject, plain, html string) (string, error) {
	if strings.ContainsAny(to+subject+s.From, "\r\n") {
		return "", fmt.Errorf("invalid mail header")
	}
	from, err := mail.ParseAddress(s.From)
	if err != nil {
		return "", fmt.Errorf("invalid sender address")
	}
	recipient, err := mail.ParseAddress(to)
	if err != nil {
		return "", fmt.Errorf("invalid recipient address")
	}
	if html != "" && from.Name == "" {
		from.Name = "CCF"
	}
	domain := host
	if at := strings.LastIndexByte(from.Address, '@'); at >= 0 {
		domain = from.Address[at+1:]
	}
	var message bytes.Buffer
	fmt.Fprintf(&message, "From: %s\r\nTo: %s\r\nDate: %s\r\nMessage-ID: <%s@%s>\r\nSubject: %s\r\nMIME-Version: 1.0\r\nAuto-Submitted: auto-generated\r\n",
		from.String(), recipient.String(), time.Now().UTC().Format(time.RFC1123Z), uuid.NewString(), domain, mime.QEncoding.Encode("UTF-8", subject))
	if html == "" {
		message.WriteString("Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n")
		if err := writeQuotedPrintable(&message, plain); err != nil {
			return "", err
		}
		return message.String(), nil
	}
	parts := multipart.NewWriter(&message)
	fmt.Fprintf(&message, "Content-Type: multipart/alternative; boundary=%q\r\n\r\n", parts.Boundary())
	for _, part := range []struct{ kind, body string }{{"text/plain", plain}, {"text/html", html}} {
		h := textproto.MIMEHeader{}
		h.Set("Content-Type", part.kind+"; charset=UTF-8")
		h.Set("Content-Transfer-Encoding", "quoted-printable")
		w, err := parts.CreatePart(h)
		if err != nil {
			return "", err
		}
		if err = writeQuotedPrintable(w, part.body); err != nil {
			return "", err
		}
	}
	if err := parts.Close(); err != nil {
		return "", err
	}
	return message.String(), nil
}

func writeQuotedPrintable(w io.Writer, text string) error {
	// Normalize both existing CRLF and LF without doubling carriage returns.
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
	text = strings.ReplaceAll(text, "\n", "\r\n")
	qp := quotedprintable.NewWriter(w)
	if _, err := io.WriteString(qp, text); err != nil {
		return err
	}
	return qp.Close()
}
