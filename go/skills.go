package agentthreads

import (
	"io/fs"
	"os"
	"path/filepath"
)

// writeSkills writes the app's skills into root as <name>/SKILL.md directories, for a harness to
// load (a skill given as a directory is copied, with what it refers to).
func writeSkills(root string, skills []Skill) (string, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", err
	}
	for _, s := range skills {
		if s.Dir != "" {
			src, err := filepath.Abs(s.Dir)
			if err != nil {
				return "", err
			}
			if err := copyDir(src, filepath.Join(root, filepath.Base(src))); err != nil {
				return "", err
			}
			continue
		}
		dir := filepath.Join(root, s.Name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", err
		}
		if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(s.Content), 0o644); err != nil {
			return "", err
		}
	}
	return root, nil
}

func copyDir(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		to := filepath.Join(dst, rel)
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		if info.IsDir() {
			return os.MkdirAll(to, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(to, data, info.Mode().Perm())
	})
}
