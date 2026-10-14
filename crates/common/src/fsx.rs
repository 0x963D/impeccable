//! Filesystem helpers shared by the verb crates.

use std::path::{Path, PathBuf};

/// Replace `path` with `bytes` atomically: write a sibling temp file, then
/// rename it over the target, so a crash or a full disk never leaves a
/// truncated file behind. A symlinked target (a dotfiles checkout of
/// `~/.claude/settings.json`) is resolved first, so the link stays in place
/// and the file it points at is the one replaced. An existing file's
/// permissions carry over to the replacement.
pub fn write_atomic(path: impl AsRef<Path>, bytes: &[u8]) -> std::io::Result<()> {
    let path = path.as_ref();
    let target: PathBuf = match std::fs::canonicalize(path) {
        Ok(real) => real,
        Err(_) => path.to_path_buf(),
    };
    let dir = match target.parent() {
        Some(d) if !d.as_os_str().is_empty() => d.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let temp = dir.join(format!(".{name}.{}.{nanos}.tmp", std::process::id()));
    let result = (|| {
        std::fs::write(&temp, bytes)?;
        if let Ok(meta) = std::fs::metadata(&target) {
            let _ = std::fs::set_permissions(&temp, meta.permissions());
        }
        std::fs::rename(&temp, &target)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "impeccable-fsx-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn writes_new_and_replaces_existing() {
        let d = tmp("replace");
        let f = d.join("a.json");
        write_atomic(&f, b"one").unwrap();
        write_atomic(&f, b"two").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "two");
        let leftovers: Vec<_> = std::fs::read_dir(&d).unwrap().collect();
        assert_eq!(leftovers.len(), 1, "temp file left behind");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_a_symlinked_target_linked() {
        let d = tmp("symlink");
        let real = d.join("real.json");
        let link = d.join("link.json");
        std::fs::write(&real, b"old").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        write_atomic(&link, b"new").unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&real).unwrap(), "new");
        let _ = std::fs::remove_dir_all(&d);
    }
}
