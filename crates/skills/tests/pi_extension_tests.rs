//! The Pi design-hook extension install: Pi loads extensions from the dir
//! that holds its skills dir, so the extension is copied beside each Pi skill
//! install, in the project's `.pi/` or in Pi's agent dir.

use impeccable_common::jsp;
use impeccable_skills::hook_manifest::{copy_provider_hooks, hook_installed_for_provider, hook_installed_for_provider_at_scope};
use impeccable_skills::providers::{Scope, Sys};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const EXTENSION: &str = "extensions/impeccable-design-hook";
const BUNDLED: &str = "export default function () {}\n";
/// Where each scope keeps Pi's files, relative to the fixture root.
const PROJECT_PI: &str = "project/.pi";
const GLOBAL_PI: &str = "home/.pi/agent";

struct Fixture {
    root: PathBuf,
    bundle: String,
    home: String,
    project: String,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let root = std::env::temp_dir().join(format!("imp-pi-{name}-{}-{nanos}", std::process::id()));
        let bundle = root.join("bundle");
        std::fs::create_dir_all(bundle.join(".pi").join(EXTENSION)).unwrap();
        std::fs::write(bundle.join(".pi").join(EXTENSION).join("index.js"), BUNDLED).unwrap();
        std::fs::create_dir_all(root.join("home")).unwrap();
        std::fs::create_dir_all(root.join("project")).unwrap();
        let s = |p: PathBuf| p.to_string_lossy().into_owned();
        Fixture { bundle: s(bundle), home: s(root.join("home")), project: s(root.join("project")), root }
    }

    fn sys(&self) -> Sys {
        self.sys_at(&self.project)
    }

    /// The installer's view when it runs in `cwd`.
    fn sys_at(&self, cwd: &str) -> Sys {
        let mut env = HashMap::new();
        env.insert("HOME".to_string(), self.home.clone());
        env.insert("USERPROFILE".to_string(), self.home.clone());
        Sys::new(env, cwd.to_string())
    }

    /// Stages an installed Pi skill under `base` (`PROJECT_PI` or `GLOBAL_PI`).
    fn with_skill(self, base: &str) -> Self {
        let skill = self.root.join(base).join("skills/impeccable");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "---\nname: impeccable\n---\n").unwrap();
        self
    }

    /// Installs the hook the way `install` does: project manifests root at the
    /// project, the skill root is the home dir for a global install.
    fn install(&self, sys: &Sys, global: bool) -> Result<Vec<String>, String> {
        let (skill_root, scope) = if global { (Some(self.home.as_str()), Scope::User) } else { (None, Scope::Project) };
        copy_provider_hooks(sys, &self.bundle, &self.project, &[".pi"], false, skill_root, None, Some(scope))
    }

    fn extension_file(&self, base: &str) -> PathBuf {
        self.root.join(base).join(EXTENSION).join("index.js")
    }

    /// The extension dir under `base`, as install reports it.
    fn dest(&self, base: &str) -> String {
        let (root, rest) = base.split_once('/').unwrap();
        let root = if root == "home" { &self.home } else { &self.project };
        let mut parts = vec![root.as_str()];
        parts.extend(rest.split('/'));
        parts.extend(EXTENSION.split('/'));
        jsp::join(&parts)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn project_install_writes_the_extension_beside_the_project_skill() {
    let f = Fixture::new("project").with_skill(PROJECT_PI);
    let sys = f.sys();
    assert!(!hook_installed_for_provider(&sys, &f.project, ".pi"));
    assert!(!hook_installed_for_provider_at_scope(&sys, &f.project, ".pi", false));
    assert_eq!(f.install(&sys, false).unwrap(), vec![f.dest(PROJECT_PI)]);
    assert_eq!(std::fs::read_to_string(f.extension_file(PROJECT_PI)).unwrap(), BUNDLED);
    assert!(!Path::new(&f.home).join(".pi").exists(), "a project install leaves the agent dir alone");
    assert!(hook_installed_for_provider(&sys, &f.project, ".pi"));
    assert!(hook_installed_for_provider_at_scope(&sys, &f.project, ".pi", false));
    assert!(!hook_installed_for_provider_at_scope(&sys, &f.project, ".pi", true), "nothing at user scope");
    // Idempotent.
    assert_eq!(f.install(&sys, false).unwrap(), vec![f.dest(PROJECT_PI)]);
}

#[test]
fn global_install_writes_the_extension_into_the_agent_dir() {
    let f = Fixture::new("global").with_skill(GLOBAL_PI);
    let sys = f.sys();
    assert_eq!(f.install(&sys, true).unwrap(), vec![f.dest(GLOBAL_PI)]);
    assert_eq!(std::fs::read_to_string(f.extension_file(GLOBAL_PI)).unwrap(), BUNDLED);
    assert!(!Path::new(&f.project).join(".pi").exists(), "a global install writes nothing into the project");
    assert!(hook_installed_for_provider_at_scope(&sys, &f.project, ".pi", true));
    assert!(!hook_installed_for_provider_at_scope(&sys, &f.project, ".pi", false), "nothing at project scope");
    assert!(hook_installed_for_provider(&sys, &f.project, ".pi"), "the agent dir copy covers every project");
}

#[test]
fn a_home_rooted_install_touches_only_its_own_scope() {
    // Under the home dir Pi keeps a project's skills in `.pi/skills` and the
    // user's in `.pi/agent/skills`, each with its own extensions dir.
    const HOME_PROJECT_PI: &str = "home/.pi";
    let f = Fixture::new("home-rooted").with_skill(HOME_PROJECT_PI).with_skill(GLOBAL_PI);
    let sys = f.sys_at(&f.home);
    let install = |scope| copy_provider_hooks(&sys, &f.bundle, &f.home, &[".pi"], false, Some(&f.home), None, scope).unwrap();

    assert_eq!(install(Some(Scope::Project)), vec![f.dest(HOME_PROJECT_PI)]);
    assert!(!f.extension_file(GLOBAL_PI).exists(), "a project install leaves the user's extension alone");
    assert!(hook_installed_for_provider_at_scope(&sys, &f.home, ".pi", false));
    assert!(!hook_installed_for_provider_at_scope(&sys, &f.home, ".pi", true));

    // Pi loads the home dir's project extension in that project only, so it
    // is no hook for another one.
    assert!(hook_installed_for_provider(&sys, &f.home, ".pi"));
    assert!(!hook_installed_for_provider(&f.sys(), &f.project, ".pi"));

    std::fs::remove_file(f.extension_file(HOME_PROJECT_PI)).unwrap();
    assert_eq!(install(Some(Scope::User)), vec![f.dest(GLOBAL_PI)]);
    assert!(!f.extension_file(HOME_PROJECT_PI).exists(), "a global install leaves the project's extension alone");
    assert!(hook_installed_for_provider_at_scope(&sys, &f.home, ".pi", true));
    assert!(!hook_installed_for_provider_at_scope(&sys, &f.home, ".pi", false));

    // An update that inferred its scope refreshes the extension beside both.
    assert_eq!(install(None), vec![f.dest(GLOBAL_PI), f.dest(HOME_PROJECT_PI)]);
}

#[test]
fn without_a_pi_skill_there_is_nothing_to_install_beside() {
    // The extension only runs the launcher beside it.
    let f = Fixture::new("no-skill");
    let sys = f.sys();
    assert_eq!(f.install(&sys, false).unwrap(), Vec::<String>::new());
    assert_eq!(f.install(&sys, true).unwrap(), Vec::<String>::new());
    assert!(!f.root.join(PROJECT_PI).exists() && !f.root.join(GLOBAL_PI).exists());
    assert!(!hook_installed_for_provider(&sys, &f.project, ".pi"));
}

#[test]
fn a_stale_extension_is_replaced() {
    let f = Fixture::new("stale").with_skill(PROJECT_PI);
    let sys = f.sys();
    std::fs::create_dir_all(f.extension_file(PROJECT_PI).parent().unwrap()).unwrap();
    std::fs::write(f.extension_file(PROJECT_PI), "stale\n").unwrap();
    f.install(&sys, false).unwrap();
    assert_eq!(std::fs::read_to_string(f.extension_file(PROJECT_PI)).unwrap(), BUNDLED);
}

#[test]
fn a_bundle_without_the_extension_is_skipped() {
    // A bundle from before the extension, like a bundle without a provider's
    // manifest: nothing written, nothing reported.
    let f = Fixture::new("absent").with_skill(PROJECT_PI);
    std::fs::remove_dir_all(Path::new(&f.bundle).join(".pi").join(EXTENSION)).unwrap();
    let sys = f.sys();
    assert_eq!(f.install(&sys, false).unwrap(), Vec::<String>::new());
    assert!(!f.extension_file(PROJECT_PI).exists());
    assert!(!hook_installed_for_provider(&sys, &f.project, ".pi"));
}

#[test]
fn a_bundle_missing_the_extension_file_errors() {
    let f = Fixture::new("missing").with_skill(PROJECT_PI);
    std::fs::remove_file(Path::new(&f.bundle).join(".pi").join(EXTENSION).join("index.js")).unwrap();
    let sys = f.sys();
    let err = f.install(&sys, false).unwrap_err();
    assert!(err.contains("Pi extension") && err.contains("index.js"), "{err}");
    assert!(!f.extension_file(PROJECT_PI).exists());
}

/// Runs `install --providers=pi` at `scope` against a staged bundle zip and
/// returns its stdout.
#[cfg(unix)]
fn run_pi_install(f: &Fixture, scope: &str) -> String {
    use std::io::Write as _;
    let (os, arch) = impeccable_skills::engine_binary::platform_tag().expect("supported platform");
    std::fs::create_dir_all(Path::new(&f.project).join(".git")).unwrap();
    let zip_path = f.root.join("bundle.zip");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
    let plain = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let exec = plain.unix_permissions(0o755);
    let entries = [
        (".pi/skills/impeccable/SKILL.md".to_string(), "---\nname: impeccable\n---\n", plain),
        (".pi/skills/impeccable/scripts/impeccable".to_string(), "#!/bin/sh\nexit 0\n", exec),
        (".pi/skills/impeccable/scripts/VERSION".to_string(), "9.9.9\n", plain),
        (format!(".pi/skills/impeccable/scripts/bin/{os}-{arch}/impeccable"), "#!/bin/sh\nexit 0\n", exec),
        (format!(".pi/{EXTENSION}/index.js"), BUNDLED, plain),
    ];
    for (name, body, opts) in entries {
        zip.start_file(name, opts).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    }
    zip.finish().unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".to_string(), f.home.clone());
    env.insert("TMPDIR".to_string(), f.root.join("tmp").to_string_lossy().into_owned());
    env.insert("IMPECCABLE_BUNDLE_PATH".to_string(), zip_path.to_string_lossy().into_owned());
    std::fs::create_dir_all(f.root.join("tmp")).unwrap();
    let (mut io, captured) = impeccable_common::Io::captured("", PathBuf::from(&f.project), env);
    let scope_flag = format!("--scope={scope}");
    let args = ["install", "-y", "--providers=pi", scope_flag.as_str()].map(String::from);
    let code = impeccable_skills::run(&args, &mut io);
    let stdout = String::from_utf8_lossy(&captured.stdout.borrow()).into_owned();
    assert_eq!(code, 0, "install failed:\n{stdout}\n{}", String::from_utf8_lossy(&captured.stderr.borrow()));
    stdout
}

/// `install` puts the extension where Pi loads it for that scope, names the
/// path once, and a repeat install has nothing left to write.
#[cfg(unix)]
#[test]
fn install_places_the_extension_for_each_scope() {
    if impeccable_skills::engine_binary::platform_tag().is_none() {
        return;
    }
    for (scope, base, shown) in [
        ("project", PROJECT_PI, ".pi/extensions/impeccable-design-hook"),
        ("global", GLOBAL_PI, "~/.pi/agent/extensions/impeccable-design-hook"),
    ] {
        let f = Fixture::new(&format!("install-{scope}"));
        let first = run_pi_install(&f, scope);
        assert!(first.lines().any(|l| l.starts_with("Installed hooks into: ") && l.ends_with(shown)), "{scope}:\n{first}");
        assert_eq!(std::fs::read_to_string(f.extension_file(base)).unwrap(), BUNDLED, "{scope}");
        assert!(f.root.join(base).join("skills/impeccable/scripts/impeccable").is_file(), "{scope}: the launcher it runs");
        let repeat = run_pi_install(&f, scope);
        assert!(!repeat.contains("Installed hooks into"), "{scope}:\n{repeat}");
    }
}
