//! What a turn carries beside its text.

use agent_client_protocol::schema::v1::{
    ContentBlock, EmbeddedResource, EmbeddedResourceResource, ImageContent, TextContent,
    TextResourceContents,
};
use serde::{Deserialize, Serialize};

use super::capabilities::SessionCapabilities;

/// One thing the reader attached to a turn.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PromptAttachment {
    /// A file from the workspace, sent whole.
    Resource {
        /// Vault-relative and `/`-separated: the spelling the reader was shown.
        path: String,
        /// The file's text, as the window read it when it was attached.
        text: String,
        #[serde(rename = "mediaType")]
        media_type: String,
    },
    /// Image bytes.
    Image {
        /// What to call it: the dropped file's name, or a generated one for a paste.
        name: String,
        #[serde(rename = "mediaType")]
        media_type: String,
        /// Base64, with no `data:` prefix.
        data: String,
    },
}

impl PromptAttachment {
    /// What the reader called it, for a refusal to name.
    pub fn name(&self) -> &str {
        match self {
            PromptAttachment::Resource { path, .. } => path,
            PromptAttachment::Image { name, .. } => name,
        }
    }

    /// The ACP prompt capability this block needs, spelled as the wire spells it.
    const fn capability(&self) -> &'static str {
        match self {
            PromptAttachment::Resource { .. } => "embeddedContext",
            PromptAttachment::Image { .. } => "image",
        }
    }
}

/// Why a turn was refused: the engine's own report does not license one of its blocks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentRefusal {
    /// The attachment as the reader knows it.
    pub name: String,
    /// The capability field, as the wire spells it.
    pub capability: &'static str,
    /// What the engine's report says about it.
    pub reported: Option<bool>,
}

impl AttachmentRefusal {
    /// The sentence the window is shown.
    pub fn message(&self) -> String {
        match self.reported {
            Some(false) => format!(
                "`{}` was not sent: this engine's handshake reports `{}` as not supported",
                self.name, self.capability
            ),
            _ => format!(
                "`{}` was not sent: this session has not reported whether it reads `{}`",
                self.name, self.capability
            ),
        }
    }
}

/// The blocks one turn is made of: the reader's words, then what they attached.
///
/// The gate is the engine's own report and nothing else. A block is built only where the handshake
/// said the engine reads it, and where nothing has said — no handshake read yet — the block is
/// refused rather than sent: the two states are different facts and this is the function that must
/// not blur them, because the alternative to refusing is a client committing a protocol violation
/// on the engine's behalf and a reader who is never told.
pub fn blocks(
    text: &str,
    attachments: &[PromptAttachment],
    findings: Option<&SessionCapabilities>,
    vault_root: &str,
) -> Result<Vec<ContentBlock>, AttachmentRefusal> {
    for attachment in attachments {
        let reported = match attachment {
            PromptAttachment::Resource { .. } => {
                findings.and_then(SessionCapabilities::supports_embedded_context)
            }
            PromptAttachment::Image { .. } => {
                findings.and_then(SessionCapabilities::supports_images)
            }
        };
        if reported != Some(true) {
            return Err(AttachmentRefusal {
                name: attachment.name().to_string(),
                capability: attachment.capability(),
                reported,
            });
        }
    }

    let mut blocks = Vec::with_capacity(attachments.len() + 1);
    blocks.push(ContentBlock::Text(TextContent::new(text)));
    for attachment in attachments {
        blocks.push(match attachment {
            PromptAttachment::Resource {
                path,
                text,
                media_type,
            } => ContentBlock::Resource(EmbeddedResource::new(
                EmbeddedResourceResource::TextResourceContents(
                    TextResourceContents::new(text.clone(), file_uri(vault_root, path))
                        .mime_type(media_type.clone()),
                ),
            )),
            PromptAttachment::Image {
                media_type, data, ..
            } => ContentBlock::Image(ImageContent::new(data.clone(), media_type.clone())),
        });
    }
    Ok(blocks)
}

/// The file's own URI: the absolute path the engine's working directory resolves it against.
///
/// Absolute rather than the vault-relative spelling the reader was shown, because a `file:` URI is
/// a whole path or it is not a URI at all — a relative one would leave the engine guessing at a
/// base. Percent-encoded over the RFC 3986 `pchar` set, so a note called `a note.md` names a URI
/// with a space in it rather than an invalid one nobody can resolve.
fn file_uri(vault_root: &str, path: &str) -> String {
    let joined = if vault_root.ends_with('/') {
        format!("{vault_root}{path}")
    } else {
        format!("{vault_root}/{path}")
    };
    let mut uri = String::from("file://");
    for byte in joined.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' => uri.push(byte as char),
            b'-' | b'.' | b'_' | b'~' | b'!' | b'$' | b'&' | b'\'' | b'(' | b')' | b'*' | b'+'
            | b',' | b';' | b'=' | b':' | b'@' | b'/' => uri.push(byte as char),
            other => uri.push_str(&format!("%{other:02X}")),
        }
    }
    uri
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::capabilities::Handshake;
    use agent_client_protocol::schema::v1::{
        InitializeResponse, NewSessionResponse, PromptCapabilities,
    };

    /// The pinned engine's handshake, as P0 §2.1 measured it: both prompt capabilities reported.
    fn reports_both() -> SessionCapabilities {
        let mut response =
            InitializeResponse::new(agent_client_protocol::schema::ProtocolVersion::V1);
        response.agent_capabilities.prompt_capabilities =
            PromptCapabilities::new().image(true).embedded_context(true);
        let mut facts = SessionCapabilities::default();
        facts.negotiated(Handshake::of(&response));
        facts.opened(&NewSessionResponse::new("ses-1"));
        facts
    }

    /// A handshake that reports neither: the fixture's own `modest-handshake` behaviour.
    fn reports_neither() -> SessionCapabilities {
        let mut response =
            InitializeResponse::new(agent_client_protocol::schema::ProtocolVersion::V1);
        response.agent_capabilities.prompt_capabilities = PromptCapabilities::new();
        let mut facts = SessionCapabilities::default();
        facts.negotiated(Handshake::of(&response));
        facts.opened(&NewSessionResponse::new("ses-1"));
        facts
    }

    fn a_file() -> PromptAttachment {
        PromptAttachment::Resource {
            path: "notes/a.md".to_string(),
            text: "# a".to_string(),
            media_type: "text/markdown".to_string(),
        }
    }

    fn an_image() -> PromptAttachment {
        PromptAttachment::Image {
            name: "shot.png".to_string(),
            media_type: "image/png".to_string(),
            data: "QUJD".to_string(),
        }
    }

    #[test]
    fn the_words_come_first_and_the_attachments_after_them() {
        let blocks = blocks(
            "look at this",
            &[a_file(), an_image()],
            Some(&reports_both()),
            "/vault",
        )
        .expect("both capabilities were reported");
        assert_eq!(blocks.len(), 3);
        assert!(matches!(&blocks[0], ContentBlock::Text(t) if t.text == "look at this"));
    }

    #[test]
    fn a_file_becomes_the_engines_own_resource_block() {
        let blocks = blocks("", &[a_file()], Some(&reports_both()), "/vault").expect("licensed");
        let ContentBlock::Resource(resource) = &blocks[1] else {
            panic!("a resource attachment must go out as a resource block: {blocks:?}");
        };
        let EmbeddedResourceResource::TextResourceContents(contents) = &resource.resource else {
            panic!(
                "a text file must be embedded as text: {:?}",
                resource.resource
            );
        };
        assert_eq!(contents.text, "# a");
        assert_eq!(contents.mime_type.as_deref(), Some("text/markdown"));
        assert!(
            contents.uri.ends_with("notes/a.md"),
            "the uri must name the file: {}",
            contents.uri
        );
    }

    #[test]
    fn an_image_becomes_the_engines_own_image_block() {
        let blocks = blocks("", &[an_image()], Some(&reports_both()), "/vault").expect("licensed");
        let ContentBlock::Image(image) = &blocks[1] else {
            panic!("an image attachment must go out as an image block: {blocks:?}");
        };
        assert_eq!(image.data, "QUJD");
        assert_eq!(image.mime_type, "image/png");
    }

    #[test]
    fn a_report_that_says_no_refuses_rather_than_drops() {
        let refused = blocks("", &[an_image()], Some(&reports_neither()), "/vault")
            .expect_err("an engine that reported no image support may not be sent one");
        assert_eq!(refused.capability, "image");
        assert_eq!(refused.reported, Some(false));
        assert!(refused.message().contains("image"));
    }

    #[test]
    fn nothing_reported_is_its_own_refusal() {
        // The third arm: no handshake has been read, so nothing has said either way. It is not
        // the same state as a report that said no, and the sentence must not claim it is.
        let refused = blocks("", &[a_file()], None, "/vault").expect_err("nothing licensed it");
        assert_eq!(refused.capability, "embeddedContext");
        assert_eq!(refused.reported, None);
        assert!(
            refused.message().contains("has not reported"),
            "{}",
            refused.message()
        );
    }

    #[test]
    fn a_turn_with_nothing_attached_is_the_text_it_always_was() {
        let blocks = blocks("hello", &[], Some(&reports_both()), "/vault").expect("licensed");
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], ContentBlock::Text(t) if t.text == "hello"));
    }
}
