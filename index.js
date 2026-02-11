const fs = require("fs");
const path = require("path");

const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  SlashCommandBuilder,
  REST,
  Routes,
} = require("discord.js");

// =====================================================
// CONFIG (EDIT THESE IF YOU WANT)
// =====================================================
const SESSION_CATEGORY_NAME = "🎮 Rivalis Live Sessions";
const TRIGGER_VC_NAME = "➕ Create a Session";

// text channel where winners are announced (create this in your server)
const ANNOUNCE_CHANNEL_NAME = "live-session-results";

// all temp session VCs start with this
const SESSION_VC_PREFIX = "Rivalis — ";

// session VC max members
const SESSION_USER_LIMIT = 6;

// Back-to-back tier roles
const TIER_ROLES = [
  { streakAtLeast: 10, name: "🔥 Rivalis CHAMP" },
  { streakAtLeast: 5, name: "💎 Rivalis Winner IV" },
  { streakAtLeast: 3, name: "🥇 Rivalis Winner III" },
  { streakAtLeast: 2, name: "🥈 Rivalis Winner II" },
  { streakAtLeast: 1, name: "🥉 Rivalis Winner I" },
];

// =====================================================
// ENV (Railway Variables)
// =====================================================
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!TOKEN) throw new Error("Missing DISCORD_TOKEN env var");
if (!CLIENT_ID) throw new Error("Missing DISCORD_CLIENT_ID env var");

// =====================================================
// Tiny storage (JSON file)
// NOTE: Railway can restart -> streaks may reset.
// Later we can swap this for Firebase/Firestore.
// =====================================================
const DATA_FILE = path.join(process.cwd(), "data.json");

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

const data = loadData();

function getGuildState(guildId) {
  if (!data[guildId]) {
    data[guildId] = {
      lastWinnerId: null,
      winnerStreaks: {}
    };
  }
  return data[guildId];
}

// =====================================================
// Discord client
// =====================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel],
});

// =====================================================
// Helpers
// =====================================================
async function ensureRole(guild, roleName) {
  let role = guild.roles.cache.find(r => r.name === roleName);
  if (role) return role;

  // Create missing tier role
  role = await guild.roles.create({
    name: roleName,
    reason: "Rivalis tier role auto-create"
  });

  return role;
}

async function getTierRoleForStreak(guild, streak) {
  const tier = TIER_ROLES.find(t => streak >= t.streakAtLeast);
  if (!tier) return null;
  return ensureRole(guild, tier.name);
}

async function removeAllTierRoles(member) {
  const tierRoleNames = new Set(TIER_ROLES.map(t => t.name));
  const toRemove = member.roles.cache.filter(r => tierRoleNames.has(r.name));
  if (toRemove.size > 0) {
    await member.roles.remove(toRemove, "Rivalis tier update");
  }
}

async function findOrCreateCategory(guild) {
  let category = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name === SESSION_CATEGORY_NAME
  );

  if (!category) {
    category = await guild.channels.create({
      name: SESSION_CATEGORY_NAME,
      type: ChannelType.GuildCategory,
      reason: "Rivalis sessions category auto-create"
    });
  }

  return category;
}

async function findOrCreateTriggerVC(guild, categoryId) {
  let trigger = guild.channels.cache.find(
    c =>
      c.type === ChannelType.GuildVoice &&
      c.name === TRIGGER_VC_NAME &&
      c.parentId === categoryId
  );

  if (!trigger) {
    trigger = await guild.channels.create({
      name: TRIGGER_VC_NAME,
      type: ChannelType.GuildVoice,
      parent: categoryId,
      reason: "Rivalis trigger VC auto-create"
    });
  }

  return trigger;
}

async function findAnnounceChannel(guild) {
  return guild.channels.cache.find(
    c => c.type === ChannelType.GuildText && c.name === ANNOUNCE_CHANNEL_NAME
  );
}

function isRivalisTempVC(channel) {
  if (!channel) return false;
  if (channel.type !== ChannelType.GuildVoice) return false;
  if (!channel.name.startsWith(SESSION_VC_PREFIX)) return false;
  return true;
}

// =====================================================
// Slash Commands
// =====================================================
const commands = [
  new SlashCommandBuilder()
    .setName("winner")
    .setDescription("Announce winner + apply Rivalis back-to-back tier role")
    .addUserOption(opt =>
      opt
        .setName("user")
        .setDescription("Winner of the session")
        .setRequired(true)
    )
    .toJSON(),
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log("✅ Slash commands registered");
}

// =====================================================
// Join-to-create + auto-delete temp VCs
// =====================================================
client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const guild = newState.guild || oldState.guild;
    if (!guild) return;

    const category = await findOrCreateCategory(guild);
    const trigger = await findOrCreateTriggerVC(guild, category.id);

    // --- If user joined trigger VC ---
    if (newState.channelId === trigger.id && oldState.channelId !== trigger.id) {
      const member = newState.member;
      if (!member) return;

      const sessionName = `${SESSION_VC_PREFIX}${member.displayName}`;

      const sessionVC = await guild.channels.create({
        name: sessionName,
        type: ChannelType.GuildVoice,
        parent: category.id,
        userLimit: SESSION_USER_LIMIT,
        reason: "Rivalis temp session VC"
      });

      // Move user into the created VC
      await member.voice.setChannel(sessionVC, "Move to Rivalis session VC");
    }

    // --- If user left a temp session VC and it becomes empty -> delete ---
    const leftChannel = oldState.channel;
    if (isRivalisTempVC(leftChannel)) {
      if (leftChannel.members.size === 0) {
        await leftChannel.delete("Rivalis session ended (empty)");
      }
    }
  } catch (e) {
    console.error("voiceStateUpdate error:", e);
  }
});

// =====================================================
// /winner logic
// =====================================================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "winner") return;

  try {
    const guild = interaction.guild;
    if (!guild) {
      return interaction.reply({ content: "Run this inside a server.", ephemeral: true });
    }

    const winnerUser = interaction.options.getUser("user", true);
    const winnerMember = await guild.members.fetch(winnerUser.id);

    const state = getGuildState(guild.id);
    const prevWinnerId = state.lastWinnerId;

    const prevStreak = Number(state.winnerStreaks[winnerUser.id] || 0);

    // Back-to-back logic
    let newStreak = 1;
    if (prevWinnerId === winnerUser.id) {
      newStreak = prevStreak + 1;
    } else {
      newStreak = 1;
    }

    // Save
    state.lastWinnerId = winnerUser.id;
    state.winnerStreaks[winnerUser.id] = newStreak;
    saveData(data);

    // Apply tier roles
    await removeAllTierRoles(winnerMember);
    const tierRole = await getTierRoleForStreak(guild, newStreak);
    if (tierRole) {
      await winnerMember.roles.add(tierRole, `Rivalis winner streak: ${newStreak}`);
    }

    // Announce
    const announce = await findAnnounceChannel(guild);
    const msg =
      `🏆 **Rivalis Session Winner:** <@${winnerUser.id}>\n` +
      `🔥 **Back-to-back streak:** **${newStreak}**\n` +
      `🎖️ **Tier:** ${tierRole ? `**${tierRole.name}**` : "**None**"}`;

    if (announce) {
      await announce.send({ content: msg });
      await interaction.reply({ content: "✅ Winner announced + tier role applied.", ephemeral: true });
    } else {
      await interaction.reply({
        content:
          msg +
          `\n\n⚠️ I couldn't find #${ANNOUNCE_CHANNEL_NAME}. Create it or change ANNOUNCE_CHANNEL_NAME in index.js.`,
        ephemeral: false
      });
    }
  } catch (e) {
    console.error("/winner error:", e);
    try {
      await interaction.reply({
        content:
          "❌ Something failed. Check Railway logs.\n" +
          "Most common cause: bot role is not above the tier roles.",
        ephemeral: true
      });
    } catch {}
  }
});

// =====================================================
// Startup
// =====================================================
client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();
