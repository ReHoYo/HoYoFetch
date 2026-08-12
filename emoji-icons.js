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
// Every img.game8.co URL below was extracted from a live Game8 page (its
// reward-icon <img data-src>) and verified with a HEAD request returning
// 200 + an image/* content-type before being added here. Fandom's own
// "Special:FilePath" media-serving endpoint was tried first but is
// confirmed (both in this sandbox and against a real deployed run) to
// reject automated requests with HTTP 403 — regular Fandom wiki *content*
// pages (e.g. the HI3 codes scrape in api.js) are unaffected, only the
// image-redirect endpoint is blocked. So Game8 pages are the source of
// truth here; per-item URLs can still rot if Game8 renames a file, in
// which case /Emoji provision reports that keyword's exact HTTP status and the
// rest of the run is unaffected — fix the entry below and re-run.
//
// `tier` decides provisioning order if the 100-emoji server cap would
// otherwise be exceeded: 1 = premium/soft currency, 2 = EXP/upgrade
// materials, 3 = stamina/energy/consumables. Lower tiers provision first.

// No dedicated Game8 page carries an icon for HSR's "Adventure Log" —
// falls back to Game8's HSR hub icon (verified reachable) rather than a
// guessed filename that would just add another 404.
const HSR_FALLBACK_ICON =
  "https://img.game8.co/3642210/daaaa1c27a3ad015412368150d5f712a.png/thumb";

// Honkai Impact 3rd has NO manifest entries at all: Game8 has no active
// hub for the game (its page 404s), Fandom's media endpoint is blocked
// (see above), and every img-os-static.hoyolab.com community-upload icon
// tried for it has rotted (404, confirmed with a HEAD request) — including
// the one GAMES.honkai3rd.icon used to point at (config.js now uses the
// official site's favicon there instead, a lower-risk fallback for a
// plain embed <img> than for something Autumn has to store as an emoji).
// HI3 reward keywords simply render via their Unicode fallback in custom
// mode too, since getEmojiMap() merges Unicode for any unprovisioned
// keyword — add real entries here if a reliable source ever turns up.

export const EMOJI_ICON_MANIFEST = [
  // ── Genshin Impact ──────────────────────────────
  {
    keyword: "primogem",
    name: "primogem",
    tier: 1,
    url: "https://img.game8.co/3321098/7e0e52f26201dc1b4d7a937587524e9d.png/show",
  },
  {
    keyword: "mora",
    name: "mora",
    tier: 1,
    url: "https://img.game8.co/3321099/112622e62752a594b94290f6f2b9d751.png/show",
  },
  {
    keyword: "hero's wit",
    name: "heros_wit",
    tier: 2,
    url: "https://img.game8.co/3316462/ce145c72d040868287e3b767106988ef.png/show",
  },
  {
    keyword: "adventurer's experience",
    name: "adventurers_experience",
    tier: 2,
    url: "https://img.game8.co/3316461/5d35ffc19710c83e0174f7dce153130e.png/show",
  },
  {
    keyword: "mystic enhancement ore",
    name: "mystic_enhancement_ore",
    tier: 2,
    url: "https://img.game8.co/3316332/dcbcc34ae19678605d2fc24706d13de8.png/show",
  },
  {
    keyword: "fine enhancement ore",
    name: "fine_enhancement_ore",
    tier: 2,
    url: "https://img.game8.co/3316331/c240ef650b4e0bdb54dfef4ab1328341.png/show",
  },
  {
    keyword: "resin",
    name: "resin",
    tier: 3,
    url: "https://img.game8.co/3275567/2c05e7b4f4a8dd333a546bc75003d9b3.jpeg/show",
  },
  // ── Honkai: Star Rail ───────────────────────────
  {
    keyword: "stellar jade",
    name: "stellar_jade",
    tier: 1,
    url: "https://img.game8.co/3671963/3db0ccc7872e144c24a041453e9b7772.png/show",
  },
  {
    keyword: "credit",
    name: "credit",
    tier: 1,
    url: "https://img.game8.co/3714201/5035667c4a87fab2ad217ace2dd1c071.png/show",
  },
  {
    keyword: "traveler's guide",
    name: "travelers_guide",
    tier: 2,
    url: "https://img.game8.co/3656147/e731ac0f85a7949e45c11f193e004807.png/show",
  },
  {
    keyword: "adventure log",
    name: "adventure_log",
    tier: 2,
    url: HSR_FALLBACK_ICON,
  },
  {
    keyword: "refined aether",
    name: "refined_aether",
    tier: 2,
    url: "https://img.game8.co/3656149/64ce6a2836a5b39dfdd4999724175f91.png/show",
  },
  {
    keyword: "condensed aether",
    name: "condensed_aether",
    tier: 2,
    url: "https://img.game8.co/3656137/c6bc7981080feff34447255d3015d9b8.png/show",
  },
  {
    keyword: "trailblaze power",
    name: "trailblaze_power",
    tier: 3,
    url: "https://img.game8.co/3655047/c6fc5e8cc61da5fc7215316e083053ad.png/show",
  },
  // ── Zenless Zone Zero ───────────────────────────
  {
    keyword: "polychrome",
    name: "polychrome",
    tier: 1,
    url: "https://img.game8.co/3893331/e6ee639872c119aa6895758f3a755d3b.png/show",
  },
  {
    keyword: "dennies",
    name: "dennies",
    tier: 1,
    url: "https://img.game8.co/3893368/7db931d2138edcfb9e155907503f2fbe.png/show",
  },
  {
    keyword: "senior investigator log",
    name: "senior_investigator_log",
    tier: 2,
    url: "https://img.game8.co/3893363/ab0406e53b7f8c4afe08096a2f7aa587.png/show",
  },
  {
    keyword: "w-engine energy module",
    name: "w_engine_energy_module",
    tier: 2,
    url: "https://img.game8.co/3893358/5b340a111348c643cedd0567c6ef2cae.png/show",
  },
  {
    keyword: "battery charge",
    name: "battery_charge",
    tier: 3,
    url: "https://img.game8.co/3893767/6c55ed4353a05bf13114f2049640b594.png/show",
  },
  // Honkai Impact 3rd: intentionally no entries — see the comment above.
  // ── Neverness to Everness ───────────────────────
  {
    keyword: "annulith",
    name: "annulith",
    tier: 1,
    url: "https://img.game8.co/4490336/9653e4406bcc4efeb361690d1b885885.png/show",
  },
  {
    keyword: "fons",
    name: "fons",
    tier: 1,
    url: "https://img.game8.co/4490335/0da9b968e33f3f16231b004f4900fb1f.png/show",
  },
  {
    keyword: "beetle coin",
    name: "beetle_coin",
    tier: 1,
    url: "https://img.game8.co/4490228/74d6788ac5f0ec1334e458703231ed24.png/show",
  },
  {
    keyword: "rising hunter guide",
    name: "rising_hunter_guide",
    tier: 2,
    url: "https://img.game8.co/4490227/2d5286bd42b6014a8b8bdbb8d3cf1e0b.png/show",
  },
  {
    keyword: "senior hunter guide",
    name: "senior_hunter_guide",
    tier: 2,
    url: "https://img.game8.co/4490225/20bf14a728d3a2bd1af1ee8c9ec855db.png/show",
  },
  {
    keyword: "elite hunter guide",
    name: "elite_hunter_guide",
    tier: 2,
    url: "https://img.game8.co/4490233/e1354fd58f9be588361f61f455d53e0c.png/show",
  },
  {
    keyword: "light dye",
    name: "light_dye",
    tier: 3,
    url: "https://img.game8.co/4490232/e9b7ff9bb482f262ace45125ea751283.png/show",
  },
  {
    keyword: "colorless dye",
    name: "colorless_dye",
    tier: 3,
    url: "https://img.game8.co/4490229/7a722d87ef9a9d393e839367c9cacc71.png/show",
  },
  {
    keyword: "colourless dye",
    name: "colourless_dye",
    tier: 3,
    url: "https://img.game8.co/4490229/7a722d87ef9a9d393e839367c9cacc71.png/show",
  },
  {
    keyword: "chaotic dye",
    name: "chaotic_dye",
    tier: 3,
    url: "https://img.game8.co/4490226/be1251e6f8f70aa686eb619377c8ce83.png/show",
  },
  {
    keyword: "dynamik",
    name: "dynamik",
    tier: 3,
    url: "https://img.game8.co/4490677/51d6e4ddf5f85597e688a7e1404795ed.png/show",
  },
  {
    keyword: "clicky fries",
    name: "clicky_fries",
    tier: 3,
    url: "https://img.game8.co/4491698/047ce534dc9496058df19579d24bd27c.png/show",
  },
  // ── Wuthering Waves ─────────────────────────────
  {
    keyword: "astrite",
    name: "wuwa_astrite",
    tier: 1,
    url: "https://img.game8.co/4312299/350fce7d8386fed17d06e47cd22a467d.png/show",
  },
  {
    keyword: "shell credit",
    name: "shell_credit",
    tier: 1,
    url: "https://img.game8.co/4312648/6671d1c910bc756b43f9ecbccb108adb.png/show",
  },
  {
    keyword: "resonance potion",
    name: "resonance_potion",
    tier: 3,
    url: "https://img.game8.co/4312624/676d7f3e710fff8dd835f0b6ad76dbfe.png/show",
  },
  {
    keyword: "revival inhaler",
    name: "revival_inhaler",
    tier: 3,
    url: "https://img.game8.co/4312571/e136c5d8499c215cc65121aa0394bf60.png/show",
  },
  {
    keyword: "energy bag",
    name: "energy_bag",
    tier: 3,
    url: "https://img.game8.co/4312565/3cbcdebe976d5e212bc2159068be26b8.png/show",
  },
  {
    keyword: "energy core",
    name: "wuwa_energy_core",
    tier: 2,
    url: "https://img.game8.co/4312265/9b9afbf99b7deea1291796f4ad87b559.png/show",
  },
  {
    keyword: "sealed tube",
    name: "sealed_tube",
    tier: 2,
    url: "https://img.game8.co/4312282/ee46a9b6d6e90cc2c0cc37f3e763635e.png/show",
  },
  {
    keyword: "tuner",
    name: "wuwa_tuner",
    tier: 2,
    url: "https://img.game8.co/4312645/77034dafd48ba05ccc722285b25dd179.png/show",
  },
  {
    keyword: "nutrient block",
    name: "nutrient_block",
    tier: 3,
    url: "https://img.game8.co/4312568/245d39498bc71dc158af54621c38737c.png/show",
  },
];
