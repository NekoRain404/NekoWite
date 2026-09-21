//! A library refusal, as the sentence a user reads.
//!
//! **Why this is a module of its own.** `ResourceRefusal` is a closed vocabulary for a caller to
//! map — `resources.rs` says so — and the caller of this path is a settings page with no mapper of
//! its own, so the sentence is written once, here, next to the state it is about. Two other modules
//! of this tree ask for it ([`super::listing::entries`], [`super::id::free_character_id`]) and
//! neither grows a copy: a refusal is *data* in the library and a *sentence* here, and a second
//! place that turned one into the other is how the two come to disagree about which folder a user
//! should rename.
//!
//! It moves when `resources`' refusal vocabulary does — one arm for each variant of
//! `ResourceRefusal`, one for each variant of `PackageProblem` — and at no other time, because a
//! sentence is fixed by the refusal it describes and not by the page that shows it.

use super::super::resources::{PackageProblem, ResourceRefusal};

/// Why the library refused an operation, as a sentence a user reads.
///
/// One arm per variant of `ResourceRefusal`, and the two that name a rule (`package`, `budget`)
/// say which rule in the library's own words rather than in a code. A refusal is the *last* thing
/// between a user and a character they asked for, and "Budget" alone would be a message about this
/// module's internals.
pub fn refusal_sentence(refusal: &ResourceRefusal) -> String {
    match refusal {
        ResourceRefusal::OutsideManagedScope { root, detail } => {
            format!(
                "{} is not a folder this app may write to: {detail}",
                root.display()
            )
        }
        ResourceRefusal::InvalidName {
            field,
            value,
            detail,
        } => {
            // The reason is `name_problem`'s sentence for the clause that refused, not a
            // restatement of the field's name: "cannot be used as characterId" tells a user
            // nothing they can act on, and this sentence is the last thing between them and a
            // character. A name that was refused because the library could not *read* it never
            // reaches this arm — that is `NoSource` or `Io`, and it says so in its own words.
            format!("{value} cannot be used as {field}: {detail}")
        }
        ResourceRefusal::NoSource { path } => {
            format!(
                "{} is not a file or a folder this app can read",
                path.display()
            )
        }
        ResourceRefusal::Package {
            name,
            problem,
            detail,
        } => format!(
            "{name} cannot be imported ({}): {detail}",
            package_problem(*problem)
        ),
        ResourceRefusal::Unrecognized { name } => {
            format!("{name} is not a file type this app can identify from its own contents")
        }
        ResourceRefusal::Budget { rule, limit, found } => {
            format!("the pack breaks the {rule} budget: {found} where the limit is {limit}")
        }
        ResourceRefusal::MalformedManifest { detail } => {
            format!("the pack's pet.json is not readable as one: {detail}")
        }
        ResourceRefusal::NoSheet => "the pack holds no spritesheet".to_string(),
        ResourceRefusal::AmbiguousSheet { names } => format!(
            "the pack holds more than one spritesheet ({}); a character is drawn from one",
            names.join(", ")
        ),
        ResourceRefusal::AlreadyInstalled { character_id } => {
            format!("a character called {character_id} is already installed")
        }
        ResourceRefusal::NotInstalled { character_id } => {
            format!("no character called {character_id} is installed")
        }
        ResourceRefusal::Unmanaged { character_id } => format!(
            "{character_id} is in the library without a record this build wrote, so it cannot be \
             removed or drawn"
        ),
        ResourceRefusal::Io { path, detail } => {
            format!("{} could not be read or written: {detail}", path.display())
        }
    }
}

/// What a pack refused a file *for*, in a sentence.
fn package_problem(problem: PackageProblem) -> &'static str {
    match problem {
        PackageProblem::Archive => "an archive is not unpacked",
        PackageProblem::Symlink => "a link is not followed",
        // The category, not the reason: which clause refused is in the refusal's own `detail`,
        // and this arm has to stay true for all of them (a separator, a leading dot, a control
        // character, a name that is too long).
        PackageProblem::UnusableName => "its name is not a name the library can hold",
        PackageProblem::Directory => "a pack is a flat set of files",
        PackageProblem::Script => "an executable or document is not carried into the library",
    }
}

#[cfg(test)]
mod tests;
