use nekowite_lib::desktop_pet::feature_switch::apply;
use nekowite_lib::desktop_pet::settings::{
    values::defaults, PetSettingsDomain, PetSettingsRecord, PET_SETTINGS_SCHEMA_VERSION,
};

use crate::support::with_host;

fn record(domain: PetSettingsDomain) -> PetSettingsRecord {
    PetSettingsRecord {
        domain,
        schema_version: PET_SETTINGS_SCHEMA_VERSION,
        revision: 1,
        values: defaults(domain),
    }
}

#[test]
fn character_selection_rebinds_the_existing_window_before_another_general_save() {
    let (mut host, surfaces) = with_host();
    apply(&mut host, &record(PetSettingsDomain::General), "old");
    let label = host.instances()[0].label.clone();
    apply(&mut host, &record(PetSettingsDomain::Character), "new");
    assert_eq!(host.instances()[0].character_id, "new");
    apply(&mut host, &record(PetSettingsDomain::General), "new");
    assert_eq!(host.instances().len(), 1);
    assert_eq!(host.instances()[0].label, label);
    assert_eq!(surfaces.character_opens().len(), 1);
}

#[test]
fn selecting_a_character_preserves_explicit_additional_instances() {
    let (mut host, _) = with_host();
    apply(&mut host, &record(PetSettingsDomain::General), "old");
    let extra = host.open("extra").unwrap();
    apply(&mut host, &record(PetSettingsDomain::Character), "new");
    apply(&mut host, &record(PetSettingsDomain::General), "new");
    assert_eq!(host.instances().len(), 2);
    assert!(host.instances().iter().any(|instance| instance == &extra));
}

#[test]
fn selecting_while_character_windows_are_off_does_not_open_one() {
    let (mut host, surfaces) = with_host();
    apply(&mut host, &record(PetSettingsDomain::Character), "new");
    assert!(host.instances().is_empty());
    assert!(surfaces.opened().is_empty());
}

#[test]
fn closing_the_selected_instance_does_not_reassign_an_explicit_extra() {
    let (mut host, _) = with_host();
    apply(&mut host, &record(PetSettingsDomain::General), "old");
    let label = host.instances()[0].label.clone();
    let extra = host.open("extra").unwrap();
    host.close_own(&crate::support::caller(label.as_str()))
        .unwrap();
    apply(&mut host, &record(PetSettingsDomain::Character), "new");
    assert_eq!(host.instances(), &[extra.clone()]);
    apply(&mut host, &record(PetSettingsDomain::General), "new");
    assert_eq!(host.instances().len(), 2);
    assert!(host.instances().iter().any(|instance| instance == &extra));
}
