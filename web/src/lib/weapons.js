// CS2 weapon numbers, shared by the viewmodel (weapons/viewmodel.js) and the co-op server's shot checks
// (server/coop-check.js), so a client can't claim more than the gun does.
// scripts/weapons.vdata, and CS:GO's knife code where CS2 still behaves the same:
// AK-47: m_nDamage 36, m_flCycleTime 0.1 (600 RPM), m_bIsFullAuto, m_flRange 8192, m_flDeployDuration 1.0.
// Knife (CSKnife::SwingOrStab): slash refires 0.4 s after a miss, 40 damage on the first swing and 25 on a
// follow-up (a swing within 0.4 s of the refire time); stab 65, refires 1.0 s. Range 48 slash, 32 stab.
// clip 30, reserve 90 (kept full: ZE servers run CS2Fixes cs2f_infinite_reserve_ammo 1), reload 2.43 s.
export const WEAPONS = Object.freeze({
  gun: Object.freeze({ chassis: 'rifle_ak', deploy: 1.0, cycle: 0.1, damage: 36, range: 8192, clip: 30, reserve: 90, reload: 2.43 }),
  knife: Object.freeze({
    chassis: 'knife_default_ct', deploy: 1.0,
    slash: Object.freeze({ cycle: 0.4, cycle2: 0.4, first: 40, follow: 25, range: 48 }),
    stab: Object.freeze({ cycle: 1.0, cycle2: 1.0, damage: 65, range: 32 }),
  }),
});
