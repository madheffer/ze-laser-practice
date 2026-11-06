// ze_surf_dark_fantasy_v2go2's scripts/vscripts/ze_surf_dark_fantasy/bosshp_queen.nut, on boss_queen_phbox: the Queen
// (the ghost of "Secret - Ghosts", the true ending's boss arena). Every function of the file, its numbers as written.
//
// HP: 150 + 50 x iBossMultiplier per living human (65 in Dark Mode). iBossMultiplier is the admin room's
// SetBossHPMultiplier (stripper, 7-15), 10 unless a server sets it; Dark Mode is off unless an admin turns it on.
// Each bullet takes 1 (OnHealthChanged -> Subtract_HP(1), added 2 s into the fight), an HE grenade 90.
// Attacks: boss_queen_timer_random_attack (every 11-16 s) -> Handler_Attack, RandomInt(1, 4):
//   1-3 "Uganda": 60 spawns 0.16 s apart of one of three makers on the spinning boss_queen_rot (forward, reverse,
//       from above); 4 "Lasers": 20 spawns 0.5 s apart of boss_attack_PT_laser from boss_queen_laser_maker.
// The HUD the script drives (stm_bosshud AddBoss / UpdateTimer / RemoveBoss) is the game's own boss bar here: the
// stage's boss counter reads the physbox's state.v (app/bosses.js, counterMode "hits").
const MULTIPLIER = 10;
const DARK_MODE = false;

const fire = (e, target, input, param, delay) => e.engine.fire(target, input, param, delay, null, e);
const self = (e, code, delay) => e.engine.fire(e, 'RunScriptCode', code, delay, null, e);

export default {
  init(s) { Object.assign(s, { iHP: 1000, bBossDead: false, iCountAttack: 60 }); },
  fns: {
    // the admin room's setters (stm_adminroom IsDarkmode / GetBossHPM call these back); this port keeps the defaults
    SetDarkMode() {},
    SetBossHPM() {},

    init_Boss(e) {
      fire(e, 'stm_adminroom', 'RunScriptCode', 'IsDarkmode();', 0);
      fire(e, 'stm_adminroom', 'RunScriptCode', 'GetBossHPM();', 0);
      self(e, 'AddHealth_Boss();', 0.02);
      fire(e, 'stm_bosshud', 'RunScriptCode', 'AddBoss(10);', 0.04);
      e.engine.fire(e, 'AddOutput', 'OnHealthChanged !self:RunScriptCode:Subtract_HP(1);:0:-1', 2.0, null, e);

      fire(e, 'stm_sfx_nade', 'AddOutput', 'SourceEntityName boss_queen_phbox', 1.9);
      fire(e, 'boss_queen_he', 'Enable', '', 2.0);
      fire(e, 'server', 'Command', 'say ***Fight***', 2.0);

      fire(e, 'boss_queen_timer_random_attack', 'Enable', '', 2.0);

      fire(e, 'stm_script', 'RunScriptCode', 'music_stop_all();', 2.0);
      fire(e, 'lvls_true_bossarena_sound_2', 'Volume', '7', 2.1);
      fire(e, 'lvls_true_bossarena_sound_2', 'PlaySound', '', 2.1);
    },

    // every living CT: you plus the simulated team
    AddHealth_Boss(e) {
      const s = e.state.vs;
      const humans = Math.max(1, e.engine.humans | 0);
      s.iHP = 150 + humans * (DARK_MODE ? 65 : 50) * MULTIPLIER;
      e.state.v = s.iHP;
    },

    // as written: the hit that finds iHP already at 0 or below is the one that kills
    Subtract_HP(e, [iDam]) {
      const s = e.state.vs;
      if (s.iHP > 0) {
        s.iHP -= Number(iDam) || 0;
        e.state.v = Math.max(0, s.iHP);
        fire(e, 'stm_bosshud', 'RunScriptCode', 'UpdateTimer();', 0);
      } else if (!s.bBossDead) {
        s.bBossDead = true;
        e.state.v = 0;
        fire(e, 'stm_bosshud', 'RunScriptCode', 'RemoveBoss();', 0);
        fire(e, 'boss_queen_model', 'ClearParent', '', 0);
        fire(e, 'boss_queen_model', 'SetAnimation', 'death', 0.02);
        fire(e, 'boss_queen_model', 'SetAnimation', 'death_idle', 3.02);
        fire(e, 'boss_queen_timer_random_attack', 'Kill', '', 0);
        fire(e, 'boss_queen_*', 'Kill', '', 10);
        fire(e, 'lvls_true_bossarena_PT_init', 'RunScriptCode', 'BossDead();', 0);
        fire(e, 'server', 'Command', 'say ***You killed the Queen Boss***', 0);
      }
    },

    GetBossHP(e) { fire(e, 'stm_bosshud', 'RunScriptCode', `SetHP(${e.state.vs.iHP});`, 0); },

    Handler_Attack(e) {
      const s = e.state.vs;
      if (s.bBossDead) return;
      const r = 1 + Math.floor(e.engine.random() * 4); // RandomInt(1, 4)
      if (r <= 3) {
        s.iCountAttack = 60;
        attackUganda(e, r);
        fire(e, 'server', 'Command', ['', 'say ***Queen Calls Uganda***', 'say ***Queen Calls Reverse Uganda***', 'say ***Queen Calls Rain from Uganda***'][r], 0);
      } else {
        s.iCountAttack = 20;
        attackLaser(e);
        fire(e, 'server', 'Command', 'say ***Queen Throws Lasers***', 0);
      }
    },

    Attack_Uganda(e, [t]) { attackUganda(e, Number(t)); },
    Attack_Laser(e) { attackLaser(e); },
  },
};

const UGANDA = ['', 'boss_queen_uganda_rot_maker', 'boss_queen_uganda_rot_reverse_maker', 'boss_queen_uganda_rot_up_maker'];

function attackUganda(e, t) {
  const s = e.state.vs;
  if (s.bBossDead || s.iCountAttack <= 0) return;
  s.iCountAttack--;
  if (UGANDA[t]) fire(e, UGANDA[t], 'ForceSpawn', '', 0);
  self(e, `Attack_Uganda(${t});`, 0.16);
}

function attackLaser(e) {
  const s = e.state.vs;
  if (s.bBossDead || s.iCountAttack <= 0) return;
  s.iCountAttack--;
  fire(e, 'boss_queen_laser_maker', 'ForceSpawn', '', 0);
  self(e, 'Attack_Laser();', 0.5);
}
