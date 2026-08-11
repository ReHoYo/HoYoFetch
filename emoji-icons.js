// emoji-icons.js — Icon manifest for automated custom-emoji provisioning
// ────────────────────────────────────────────────────────────────────────
// Maps every UNICODE_EMOJI keyword (config.js) to a hotlinked icon URL.
// emoji-provision.js downloads each icon at provision time and uploads it
// as a Revolt server emoji — nothing here is committed to the repo, which
// keeps this consistent with how GAMES[*].icon already hotlinks game icons
// from HoYoLAB/Game8 rather than bundling third-party art.
//
// RECOMMENDED SPEC (enforced by emoji-provision.js, not here):
//   • 128×128 px, square, PNG with a transparent background
//   • Under 500 KB (Stoat's server-emoji upload cap)
//
// These URLs are best-effort — a wiki can rename or move a file at any
// time, so a stale entry here is expected to eventually 404. /EmojiSetup
// reports exactly which keywords failed to download rather than failing
// the whole run; fix the URL below and re-run, it's safe to repeat.
//
// `tier` decides provisioning order if the 100-emoji server cap would
// otherwise be exceeded: 1 = premium/soft currency, 2 = EXP/upgrade
// materials, 3 = stamina/energy/consumables. Lower tiers provision first.

function fandomFilePath(wiki, file) {
  return `https://${wiki}.fandom.com/wiki/Special:FilePath/${file}`;
}

// Neverness to Everness has no established Fandom wiki with per-item
// assets as of writing — Game8 is the game's primary source (see GAMES.nte
// in config.js). Its manifest entries below point at the game's own icon
// as a safe, known-reachable placeholder rather than a guessed per-item
// filename that would just 404; swap in real per-item icons once a source
// exists.
const NTE_PLACEHOLDER_ICON =
  "https://img.game8.co/4490666/fa0365bacaedb0ccc466e4beb8de3c5e.png/show";

export const EMOJI_ICON_MANIFEST = [
  // ── Genshin Impact ──────────────────────────────
  {
    keyword: "primogem",
    name: "primogem",
    tier: 1,
    url: fandomFilePath("genshin-impact", "Item_Primogem.png"),
  },
  {
    keyword: "mora",
    name: "mora",
    tier: 1,
    url: fandomFilePath("genshin-impact", "Item_Mora.png"),
  },
  {
    keyword: "hero's wit",
    name: "heros_wit",
    tier: 2,
    url: fandomFilePath("genshin-impact", "Item_Heros_Wit.png"),
  },
  {
    keyword: "adventurer's experience",
    name: "adventurers_experience",
    tier: 2,
    url: fandomFilePath("genshin-impact", "Item_Adventurers_Experience.png"),
  },
  {
    keyword: "mystic enhancement ore",
    name: "mystic_enhancement_ore",
    tier: 2,
    url: fandomFilePath("genshin-impact", "Item_Mystic_Enhancement_Ore.png"),
  },
  {
    keyword: "fine enhancement ore",
    name: "fine_enhancement_ore",
    tier: 2,
    url: fandomFilePath("genshin-impact", "Item_Fine_Enhancement_Ore.png"),
  },
  {
    keyword: "resin",
    name: "resin",
    tier: 3,
    url: fandomFilePath("genshin-impact", "Item_Original_Resin.png"),
  },
  // ── Honkai: Star Rail ───────────────────────────
  {
    keyword: "stellar jade",
    name: "stellar_jade",
    tier: 1,
    url: fandomFilePath("honkai-star-rail", "Stellar_Jade.png"),
  },
  {
    keyword: "credit",
    name: "credit",
    tier: 1,
    url: fandomFilePath("honkai-star-rail", "Credit.png"),
  },
  {
    keyword: "traveler's guide",
    name: "travelers_guide",
    tier: 2,
    url: fandomFilePath("honkai-star-rail", "Traveler's_Guide.png"),
  },
  {
    keyword: "adventure log",
    name: "adventure_log",
    tier: 2,
    url: fandomFilePath("honkai-star-rail", "Adventure_Log.png"),
  },
  {
    keyword: "refined aether",
    name: "refined_aether",
    tier: 2,
    url: fandomFilePath("honkai-star-rail", "Refined_Aether.png"),
  },
  {
    keyword: "condensed aether",
    name: "condensed_aether",
    tier: 2,
    url: fandomFilePath("honkai-star-rail", "Condensed_Aether.png"),
  },
  {
    keyword: "trailblaze power",
    name: "trailblaze_power",
    tier: 3,
    url: fandomFilePath("honkai-star-rail", "Trailblaze_Power.png"),
  },
  // ── Zenless Zone Zero ───────────────────────────
  {
    keyword: "polychrome",
    name: "polychrome",
    tier: 1,
    url: fandomFilePath("zenless-zone-zero", "Polychrome.png"),
  },
  {
    keyword: "dennies",
    name: "dennies",
    tier: 1,
    url: fandomFilePath("zenless-zone-zero", "Dennies.png"),
  },
  {
    keyword: "senior investigator log",
    name: "senior_investigator_log",
    tier: 2,
    url: fandomFilePath("zenless-zone-zero", "Senior_Investigator_Log.png"),
  },
  {
    keyword: "w-engine energy module",
    name: "w_engine_energy_module",
    tier: 2,
    url: fandomFilePath("zenless-zone-zero", "W-Engine_Energy_Module.png"),
  },
  {
    keyword: "battery charge",
    name: "battery_charge",
    tier: 3,
    url: fandomFilePath("zenless-zone-zero", "Battery_Charge.png"),
  },
  // ── Honkai Impact 3rd ───────────────────────────
  {
    keyword: "crystal",
    name: "crystal",
    tier: 1,
    url: fandomFilePath("honkaiimpact3", "Crystal.png"),
  },
  {
    keyword: "asterite",
    name: "asterite",
    tier: 1,
    url: fandomFilePath("honkaiimpact3", "Asterite.png"),
  },
  {
    keyword: "stamina potion",
    name: "stamina_potion",
    tier: 3,
    url: fandomFilePath("honkaiimpact3", "Stamina_Potion.png"),
  },
  {
    keyword: "coin",
    name: "hi3_coin",
    tier: 2,
    url: fandomFilePath("honkaiimpact3", "Coin.png"),
  },
  {
    keyword: "stamina",
    name: "stamina",
    tier: 3,
    url: fandomFilePath("honkaiimpact3", "Stamina.png"),
  },
  {
    keyword: "mithril",
    name: "mithril",
    tier: 2,
    url: fandomFilePath("honkaiimpact3", "Mithril.png"),
  },
  // ── Neverness to Everness (see NTE_PLACEHOLDER_ICON above) ──────
  {
    keyword: "annulith",
    name: "annulith",
    tier: 1,
    url: NTE_PLACEHOLDER_ICON,
  },
  { keyword: "fons", name: "fons", tier: 1, url: NTE_PLACEHOLDER_ICON },
  {
    keyword: "beetle coin",
    name: "beetle_coin",
    tier: 1,
    url: NTE_PLACEHOLDER_ICON,
  },
  {
    keyword: "rising hunter guide",
    name: "rising_hunter_guide",
    tier: 2,
    url: NTE_PLACEHOLDER_ICON,
  },
  {
    keyword: "senior hunter guide",
    name: "senior_hunter_guide",
    tier: 2,
    url: NTE_PLACEHOLDER_ICON,
  },
  {
    keyword: "elite hunter guide",
    name: "elite_hunter_guide",
    tier: 2,
    url: NTE_PLACEHOLDER_ICON,
  },
  {
    keyword: "light dye",
    name: "light_dye",
    tier: 3,
    url: NTE_PLACEHOLDER_ICON,
  },
  {
    keyword: "colorless dye",
    name: "colorless_dye",
    tier: 3,
    url: NTE_PLACEHOLDER_ICON,
  },
  {
    keyword: "colourless dye",
    name: "colourless_dye",
    tier: 3,
    url: NTE_PLACEHOLDER_ICON,
  },
  {
    keyword: "chaotic dye",
    name: "chaotic_dye",
    tier: 3,
    url: NTE_PLACEHOLDER_ICON,
  },
  { keyword: "dynamik", name: "dynamik", tier: 3, url: NTE_PLACEHOLDER_ICON },
  {
    keyword: "clicky fries",
    name: "clicky_fries",
    tier: 3,
    url: NTE_PLACEHOLDER_ICON,
  },
  // ── Wuthering Waves ─────────────────────────────
  {
    keyword: "astrite",
    name: "wuwa_astrite",
    tier: 1,
    url: fandomFilePath("wutheringwaves", "Astrite.png"),
  },
  {
    keyword: "shell credit",
    name: "shell_credit",
    tier: 1,
    url: fandomFilePath("wutheringwaves", "Shell_Credit.png"),
  },
  {
    keyword: "resonance potion",
    name: "resonance_potion",
    tier: 3,
    url: fandomFilePath("wutheringwaves", "Resonance_Potion.png"),
  },
  {
    keyword: "revival inhaler",
    name: "revival_inhaler",
    tier: 3,
    url: fandomFilePath("wutheringwaves", "Revival_Inhaler.png"),
  },
  {
    keyword: "energy bag",
    name: "energy_bag",
    tier: 3,
    url: fandomFilePath("wutheringwaves", "Energy_Bag.png"),
  },
  {
    keyword: "energy core",
    name: "wuwa_energy_core",
    tier: 2,
    url: fandomFilePath("wutheringwaves", "Energy_Core.png"),
  },
  {
    keyword: "sealed tube",
    name: "sealed_tube",
    tier: 2,
    url: fandomFilePath("wutheringwaves", "Sealed_Tube.png"),
  },
  {
    keyword: "tuner",
    name: "wuwa_tuner",
    tier: 2,
    url: fandomFilePath("wutheringwaves", "Tuner.png"),
  },
  {
    keyword: "nutrient block",
    name: "nutrient_block",
    tier: 3,
    url: fandomFilePath("wutheringwaves", "Nutrient_Block.png"),
  },
];
