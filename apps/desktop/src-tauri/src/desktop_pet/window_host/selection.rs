//! Settings selection changes one managed instance; explicit additional opens remain separate.

use super::{HostRefusal, PetInstance, PetWindowHost};

impl PetWindowHost {
    pub fn select_character(&mut self, character_id: &str) {
        // Closing an instance leaves its label retired. Never recreate it just to apply selection.
        let index = self
            .selected_instance
            .as_ref()
            .and_then(|label| self.instances.iter().position(|item| &item.label == label))
            .or_else(|| {
                (self.selected_instance.is_none() && !self.instances.is_empty()).then_some(0)
            });
        if let Some(index) = index {
            let instance = &mut self.instances[index];
            instance.character_id = character_id.to_string();
            self.selected_instance = Some(instance.label.clone());
        }
    }

    pub fn open_selected(&mut self, character_id: &str) -> Result<PetInstance, HostRefusal> {
        self.select_character(character_id);
        if let Some(instance) = self
            .instances
            .iter()
            .find(|item| Some(&item.label) == self.selected_instance.as_ref())
        {
            return Ok(instance.clone());
        }
        let instance = self.open(character_id)?;
        self.selected_instance = Some(instance.label.clone());
        Ok(instance)
    }
}
