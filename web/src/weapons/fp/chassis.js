// Which CS2 chassis a weapon animates on, and which are baked. Deliberately three-free: panels ask before
// deciding to load the renderer, and importing fp.js would drag in Three.js just to read a table.

// Weapon display name -> the stock chassis it rides, read off every bundle's extracted weapon_*.vmdl_c, not CS2
// naming lore. Names spelled two ways in the scraped catalogue ("M9" / "M9 Bayonet") are both listed.
export const CHASSIS_BY_WEAPON = {
  'AK-47':          'rifle_ak',              // weapon_rif_ak47
  'AUG':            'rifle_aug',             // weapon_rif_aug
  'AWP':            'rifle_awp',             // weapon_snip_awp
  'FAMAS':          'rifle_famas',           // weapon_rif_famas
  'Galil AR':       'rifle_galilar',         // weapon_rif_galilar
  'M4A1-S':         'rifle_m4a1_silencer',   // weapon_rif_m4a1_silencer
  'M4A4':           'rifle_m4a4',            // weapon_rif_m4a4
  'SG 553':         'rifle_sg556',           // weapon_rif_sg556
  'SSG 08':         'rifle_ssg08',           // weapon_snip_ssg08
  'SCAR-20':        'rifle_scar20',          // weapon_snip_scar20
  'G3SG1':          'rifle_g3sg1',           // weapon_snip_g3sg1
  'M249':           'rifle_m249',            // weapon_mach_m249
  'Negev':          'rifle_negev',           // weapon_mach_negev
  'Nova':           'rifle_nova',            // weapon_shot_nova
  'XM1014':         'rifle_xm1014',          // weapon_shot_xm1014
  'MAG-7':          'rifle_mag7',            // weapon_shot_mag7
  'Sawed-Off':      'rifle_sawedoff',        // weapon_shot_sawedoff
  'MAC-10':         'rifle_mac10',           // weapon_smg_mac10
  'MP5-SD':         'rifle_mp5sd',           // weapon_smg_mp5sd
  'MP7':            'rifle_mp7',             // weapon_smg_mp7
  'MP9':            'rifle_mp9',             // weapon_smg_mp9
  'P90':            'rifle_p90',             // weapon_smg_p90
  'PP-Bizon':       'rifle_bizon',           // weapon_smg_bizon
  'UMP-45':         'rifle_ump45',           // weapon_smg_ump45
  'Desert Eagle':   'pistol_deagle',         // weapon_pist_deagle
  'Dual Berettas':  'pistol_elite',          // weapon_pist_elite
  'Five-SeveN':     'pistol_fiveseven',      // weapon_pist_fiveseven
  'Glock-18':       'pistol_glock18',        // weapon_pist_glock18
  'GLOCK18':        'pistol_glock18',
  'P250':           'pistol_p250',           // weapon_pist_p250
  'P2000':          'pistol_hkp2000',        // weapon_pist_hkp2000
  'R8 Revolver':    'pistol_revolver',       // weapon_pist_revolver
  'Tec-9':          'pistol_tec9',           // weapon_pist_tec9
  'CZ75-Auto':      'pistol_cz75a',          // weapon_pist_cz_75
  'USP-S':          'pistol_usp',            // weapon_pist_usp_silencer
  'Bayonet':        'knife_bayonet',         // weapon_knife_bayonet
  'Bowie Knife':    'knife_bowie',           // weapon_knife_bowie
  // Absent from the custom-weapon catalogue but in the official skin catalogue the Modify page previews by;
  // without them those skins fell back to the static model despite a complete bake.
  'Falchion Knife': 'knife_falchion',        // weapon_knife_falchion
  'Navaja Knife':   'knife_navaja',          // weapon_knife_gypsy_jackknife
  'Nomad Knife':    'knife_outdoor',         // weapon_knife_outdoor
  'Paracord Knife': 'knife_cord',            // weapon_knife_cord
  'Shadow Daggers': 'knife_push',            // weapon_knife_push
  'Butterfly Knife':'knife_butterfly',       // weapon_knife_butterfly
  'Classic Knife':  'knife_css',             // weapon_knife_css
  'Flip Knife':     'knife_flip',            // weapon_knife_flip
  'Gut Knife':      'knife_gut',             // weapon_knife_gut
  'Huntsman Knife': 'knife_tactical',        // weapon_knife_tactical
  'Karambit':       'knife_karambit',        // weapon_knife_karambit
  'Kukri Knife':    'knife_kukri',           // weapon_knife_kukri
  'M9':             'knife_m9',              // weapon_knife_m9
  'M9 Bayonet':     'knife_m9',
  'Skeleton Knife': 'knife_skeleton',        // weapon_knife_skeleton
  'Stiletto Knife': 'knife_stiletto',        // weapon_knife_stiletto
  'Survival Knife': 'knife_canis',           // weapon_knife_canis
  'Talon Knife':    'knife_talon',           // weapon_knife_talon
  'Ursus Knife':    'knife_ursus',           // weapon_knife_ursus
  'Terrorist Default Knife': 'knife_default_t',
  'CT Default Knife': 'knife_default_ct',
  'Counter-Terrorist Default Knife': 'knife_default_ct',
  'HE Grenade':     'grenade_hegrenade',     // weapon_hegrenade
  'High Explosive Grenade': 'grenade_hegrenade',
};

// Last-resort chassis when a name is missing above (a new weapon in the
// catalogue): animate it on something of the right SHAPE rather than dropping it
// from the list.
export const FALLBACK_BY_CATEGORY = {
  'Rifles': 'rifle_ak',
  'SMGs': 'rifle_mp9',
  'Sniper Rifles': 'rifle_awp',
  'Shotguns': 'rifle_nova',
  'Machine Guns': 'rifle_m249',
  'Pistols': 'pistol_deagle',
  'Knives': 'knife_bayonet',
};

// CS2's viewmodel classes: rifle (also SMGs, shotguns, snipers, heavies), pistol, knife and grenade.
// Exactly the weapons with a complete bake. `gun` = clip-file suffix, `graph` = graph JSON name (glock18 -> glock);
// M4A1-S / USP-S / CT knife ride shared _default_* clip sets, so `type` carries their real weapon_type.
const W = (id, cls, gun, label, graph, type) => ({ id, cls, gun, label, graph: graph || gun, type });
export const WEAPONS = [
  W('rifle_ak', 'rifle', 'ak', 'AK-47'),
  W('rifle_m4a4', 'rifle', 'm4a4', 'M4A4'),
  W('rifle_aug', 'rifle', 'aug', 'AUG'),
  W('rifle_sg556', 'rifle', 'sg556', 'SG 553'),
  W('rifle_famas', 'rifle', 'famas', 'FAMAS'),
  W('rifle_galilar', 'rifle', 'galilar', 'Galil AR'),
  W('rifle_awp', 'rifle', 'awp', 'AWP'),
  W('rifle_ssg08', 'rifle', 'ssg08', 'SSG 08'),
  W('rifle_scar20', 'rifle', 'scar20', 'SCAR-20'),
  W('rifle_g3sg1', 'rifle', 'g3sg1', 'G3SG1'),
  W('rifle_mp9', 'rifle', 'mp9', 'MP9'),
  W('rifle_mp7', 'rifle', 'mp7', 'MP7'),
  W('rifle_mp5sd', 'rifle', 'mp5sd', 'MP5-SD'),
  W('rifle_mac10', 'rifle', 'mac10', 'MAC-10'),
  W('rifle_ump45', 'rifle', 'ump45', 'UMP-45'),
  W('rifle_p90', 'rifle', 'p90', 'P90'),
  W('rifle_bizon', 'rifle', 'bizon', 'PP-Bizon'),
  W('rifle_nova', 'rifle', 'nova', 'Nova'),
  W('rifle_xm1014', 'rifle', 'xm1014', 'XM1014'),
  W('rifle_mag7', 'rifle', 'mag7', 'MAG-7'),
  W('rifle_sawedoff', 'rifle', 'sawedoff', 'Sawed-Off'),
  W('rifle_m249', 'rifle', 'm249', 'M249'),
  W('rifle_negev', 'rifle', 'negev', 'Negev'),
  W('rifle_m4a1_silencer', 'rifle', 'rifle', 'M4A1-S', 'm4a1s', 'm4a1_silencer'),
  W('pistol_deagle', 'pistol', 'deagle', 'Desert Eagle'),
  W('pistol_usp', 'pistol', 'pistol', 'USP-S', 'usp', 'usp_silencer'),
  W('pistol_cz75a', 'pistol', 'cz75a', 'CZ75-Auto'),
  W('pistol_elite', 'pistol', 'elite', 'Dual Berettas'),
  W('pistol_revolver', 'pistol', 'revolver', 'R8 Revolver'),
  W('pistol_glock18', 'pistol', 'glock', 'Glock-18', 'glock18'),
  W('pistol_hkp2000', 'pistol', 'hkp', 'P2000', 'hkp2000'),
  W('pistol_p250', 'pistol', 'p250', 'P250'),
  W('pistol_fiveseven', 'pistol', 'fiveseven', 'Five-SeveN'),
  W('pistol_tec9', 'pistol', 'tec9', 'Tec-9'),
  W('knife_bayonet', 'knife', 'bayonet', 'Bayonet'),
  W('knife_m9', 'knife', 'm9', 'M9 Bayonet'),
  W('knife_flip', 'knife', 'flip', 'Flip Knife'),
  W('knife_gut', 'knife', 'gut', 'Gut Knife'),
  W('knife_bowie', 'knife', 'bowie', 'Bowie Knife'),
  W('knife_falchion', 'knife', 'falchion', 'Falchion Knife'),
  W('knife_push', 'knife', 'push', 'Shadow Daggers'),
  W('knife_navaja', 'knife', 'navaja', 'Navaja Knife'),
  W('knife_stiletto', 'knife', 'stiletto', 'Stiletto Knife'),
  W('knife_ursus', 'knife', 'ursus', 'Ursus Knife'),
  W('knife_tactical', 'knife', 'tactical', 'Huntsman Knife'),
  W('knife_outdoor', 'knife', 'outdoor', 'Nomad Knife'),
  W('knife_skeleton', 'knife', 'skeleton', 'Skeleton Knife'),
  W('knife_canis', 'knife', 'canis', 'Survival Knife'),
  W('knife_cord', 'knife', 'cord', 'Paracord Knife'),
  W('knife_css', 'knife', 'css', 'Classic Knife'),
  W('knife_karambit', 'knife', 'karambit', 'Karambit'),
  W('knife_butterfly', 'knife', 'butterfly', 'Butterfly Knife'),
  W('knife_talon', 'knife', 'talon', 'Talon Knife'),
  W('knife_kukri', 'knife', 'kukri', 'Kukri Knife'),
  W('knife_default_t', 'knife', 'default_t', 'Default Knife (T)'),
  W('knife_default_ct', 'knife', 'knife', 'Default Knife (CT)', 'default_ct'),
  W('grenade_hegrenade', 'grenade', 'hegrenade', 'HE Grenade', 'he'),
];

export const GLOVES = ['fullfinger', 'sporty', 'specialist', 'slick', 'motorcycle',
  'hardknuckle', 'hydra', 'bloodhound', 'brokenfang', 'handwrap', 'fingerless'];
export const GLOVE_LABEL = {
  fullfinger: 'Default (full-finger)', sporty: 'Sport Gloves', specialist: 'Specialist Gloves',
  slick: 'Driver Gloves', motorcycle: 'Moto Gloves', hardknuckle: 'Hardknuckle',
  hydra: 'Hydra Gloves', bloodhound: 'Bloodhound Gloves', brokenfang: 'Broken Fang Gloves',
  handwrap: 'Hand Wraps', fingerless: 'Fingerless',
};

// The scripts/weapons.vdata entry a chassis reads its timing from
// (fire-rates.json). Derivable from the id except where CS2's internal name
// differs from ours - each exception checked against the baked table's keys.
const VDATA_EXCEPTIONS = {
  rifle_ak: 'weapon_ak47',
  rifle_m4a4: 'weapon_m4a1',              // M4A4's internal name is weapon_m4a1
  pistol_usp: 'weapon_usp_silencer',
  pistol_glock18: 'weapon_glock',
  knife_bayonet: 'weapon_bayonet',        // the one knife without the knife_ prefix
  knife_m9: 'weapon_knife_m9_bayonet',
  knife_bowie: 'weapon_knife_survival_bowie',
  knife_navaja: 'weapon_knife_gypsy_jackknife',
  knife_talon: 'weapon_knife_widowmaker',
  knife_default_t: 'weapon_knife_t',
  knife_default_ct: 'weapon_knife',
  grenade_hegrenade: 'weapon_hegrenade',
};
// Weapons that repeat while the trigger is held: every one with `m_bIsFullAuto` true in scripts/weapons.vdata.
// Re-derive per depth-2 block like --fp-fire-rates (a flat scan hands a template's value to a weapon with none).
// Correct surprises: XM1014 and both autosnipers are full-auto; Tec-9 and Glock are not.
export const FULL_AUTO = new Set([
  'weapon_ak47', 'weapon_aug', 'weapon_bizon', 'weapon_cz75a', 'weapon_famas',
  'weapon_g3sg1', 'weapon_galilar', 'weapon_m249', 'weapon_m4a1',
  'weapon_m4a1_silencer', 'weapon_mac10', 'weapon_mp5sd', 'weapon_mp7',
  'weapon_mp9', 'weapon_negev', 'weapon_p90', 'weapon_revolver',
  'weapon_scar20', 'weapon_sg556', 'weapon_ump45', 'weapon_xm1014',
]);

/**
* Does holding the trigger keep firing? Knives do although vdata says not full-auto: melee
* (`m_bMeleeWeapon`) runs its own fire loop that repeats on the authored 0.4s.
*/
export function holdRepeats(chassisId) {
  if (chassisId?.startsWith('knife_')) return true;
  return FULL_AUTO.has(vdataNameFor(chassisId));
}

export function vdataNameFor(chassisId) {
  if (VDATA_EXCEPTIONS[chassisId]) return VDATA_EXCEPTIONS[chassisId];
  const bare = chassisId.replace(/^(rifle|pistol|knife|grenade)_/, '');
  return chassisId.startsWith('knife_') ? `weapon_knife_${bare}` : `weapon_${bare}`;
}

const BAKED = new Set(WEAPONS.map(w => w.id));

/**
* The chassis this weapon can be viewed on, or null when there is no bake (callers then show the static
* preview). `animAs` is a custom weapon's cross-weapon vdata route (e.g. `weapon_tec9`), held on that chassis.
*/
export function fpChassisFor(weaponName, category, animAs = null) {
  const routed = animAs ? [...BAKED].find(id => vdataNameFor(id) === animAs) : null;
  const id = routed || CHASSIS_BY_WEAPON[weaponName] || FALLBACK_BY_CATEGORY[category];
  return id && BAKED.has(id) ? id : null;
}
