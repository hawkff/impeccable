//! Pi: the design-hook extension installed beside its skills dir. Pi loads
//! extensions from the directory that holds `skills/`, a project's `.pi/` or
//! its agent dir (`~/.pi/agent/`), so each install carries its own copy, and
//! that copy runs the launcher of the skill beside it.

use crate::jsp;

pub const EXTENSION_NAME: &str = "impeccable-design-hook";
/// What the installer copies and Pi needs to load the extension.
pub const EXTENSION_FILES: [&str; 1] = ["index.js"];
/// The session a loaded extension serves. It sets this in Pi's environment,
/// so every shell Pi starts carries it beside Pi's own `PI_SESSION_ID`.
pub const HOOK_SESSION_ENV: &str = "IMPECCABLE_PI_HOOK_SESSION";

/// Pi's global skills dir: `<home>/.pi/agent/skills`.
pub fn global_skills_dir(home: &str) -> String {
    jsp::join(&[home, ".pi", "agent", "skills"])
}

/// `<skills dir>/../extensions/impeccable-design-hook`
pub fn extension_dir(skills_dir: &str) -> String {
    jsp::join(&[&jsp::dirname(skills_dir), "extensions", EXTENSION_NAME])
}

/// The extension's files are present beside `skills_dir`.
pub fn extension_installed(skills_dir: &str) -> bool {
    let dir = extension_dir(skills_dir);
    EXTENSION_FILES.iter().all(|f| crate::util::is_file(&jsp::join(&[&dir, f])))
}

/// Installed, with the launcher it runs. An extension with no skill beside
/// it does nothing, so it does not count as wired.
pub fn hook_ready(skills_dir: &str) -> bool {
    extension_installed(skills_dir)
        && crate::util::is_file(&jsp::join(&[skills_dir, "impeccable", "scripts", "impeccable"]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_extension_sits_beside_the_skills_dir() {
        assert_eq!(extension_dir(&jsp::join(&["/project", ".pi", "skills"])), jsp::join(&["/project", ".pi", "extensions", EXTENSION_NAME]));
        assert_eq!(
            extension_dir(&global_skills_dir("/home/u")),
            jsp::join(&["/home/u", ".pi", "agent", "extensions", EXTENSION_NAME])
        );
    }

    #[test]
    fn the_hook_is_ready_only_with_the_launcher_beside_it() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let root = std::env::temp_dir().join(format!("impeccable-pi-ready-{}-{nanos}", std::process::id()));
        let skills = root.join("skills").to_string_lossy().into_owned();
        let extension = root.join("extensions").join(EXTENSION_NAME);
        let scripts = root.join("skills/impeccable/scripts");
        assert!(!extension_installed(&skills));

        std::fs::create_dir_all(&extension).unwrap();
        std::fs::write(extension.join("index.js"), "").unwrap();
        assert!(extension_installed(&skills));
        assert!(!hook_ready(&skills), "no launcher beside the extension");

        std::fs::create_dir_all(&scripts).unwrap();
        std::fs::write(scripts.join("impeccable"), "").unwrap();
        assert!(hook_ready(&skills));
        let _ = std::fs::remove_dir_all(&root);
    }
}
