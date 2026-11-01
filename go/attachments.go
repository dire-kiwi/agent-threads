package agentthreads

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"

	"github.com/dire-kiwi/agent-threads/go/protocol"
)

// A message's attachments in the shapes harnesses take: images with data as images, files with
// textual data as their text, and other files with data written out to a path the agent is told.

type partKind int

const (
	partText partKind = iota
	partImage
	partPath
)

type part struct {
	kind      partKind
	text      string // partText
	mediaType string // partImage, partPath
	data      string // partImage: base64
	// partPath: an attachment that's a file on disk, given by path, or with data, written out.
	fileKind protocol.AttachmentKind
	path     string
	name     string
	written  bool
}

// Media types whose content goes to the agent as text.
var textual = regexp.MustCompile(`^(text/|application/(json|xml|yaml|x-yaml|toml|javascript|x-sh|x-ndjson|csv)\b)|\+(json|xml)\b`)

var unsafeName = regexp.MustCompile(`[^\w.-]+`)

// messageParts is a message as parts: its text, then each attachment. Files with data that isn't
// textual are written to dir()/attachments/<message id>/.
func messageParts(m Message, dir func() (string, error)) []part {
	parts := []part{{kind: partText, text: m.Text}}
	for i, a := range m.Attachments {
		name := a.Name
		if name == "" {
			name = a.Path
		}
		if name == "" {
			name = fmt.Sprintf("attachment-%d", i+1)
		}
		switch {
		case a.Data != "":
			if a.Kind == protocol.AttachmentKindImage {
				mt := a.MediaType
				if mt == "" {
					mt = "image/png"
				}
				parts = append(parts, part{kind: partImage, mediaType: mt, data: a.Data})
				continue
			}
			bytes, err := base64.StdEncoding.DecodeString(a.Data)
			if err != nil {
				parts = append(parts, part{kind: partText, text: fmt.Sprintf("Attached file %s couldn't be read: %v", name, err)})
				continue
			}
			if a.MediaType != "" && textual.MatchString(a.MediaType) {
				parts = append(parts, part{kind: partText, text: fmt.Sprintf("Attached file %s:\n%s", name, bytes)})
				continue
			}
			base, err := dir()
			var path string
			if err == nil {
				to := filepath.Join(base, "attachments", m.ID)
				path = filepath.Join(to, strconv.Itoa(i+1)+"-"+unsafeName.ReplaceAllString(filepath.Base(name), "_"))
				if err = os.MkdirAll(to, 0o700); err == nil {
					err = os.WriteFile(path, bytes, 0o600)
				}
			}
			if err != nil {
				parts = append(parts, part{kind: partText, text: fmt.Sprintf("Attached file %s couldn't be saved: %v", name, err)})
				continue
			}
			parts = append(parts, part{kind: partPath, fileKind: protocol.AttachmentKindFile, path: path, name: name, mediaType: a.MediaType, written: true})
		case a.Path != "":
			parts = append(parts, part{kind: partPath, fileKind: a.Kind, path: a.Path, name: name, mediaType: a.MediaType})
		}
	}
	return parts
}

// pathText is what the agent is told about an attachment that's a file on disk.
func pathText(p part) string {
	if !p.written {
		return "Attached file: " + p.path
	}
	if p.mediaType != "" {
		return fmt.Sprintf("Attached file %s (%s): %s", p.name, p.mediaType, p.path)
	}
	return fmt.Sprintf("Attached file %s: %s", p.name, p.path)
}
