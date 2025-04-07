const { SlashCommandBuilder } = require("@discordjs/builders");
const { PermissionFlagsBits } = require("discord.js");
const fs = require("node:fs");
const path = require("node:path");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("setmeetingchannel")
        .setDescription(
            "Set the channel where meeting summaries and transcripts will be posted"
        )
        .addChannelOption((option) =>
            option
                .setName("channel")
                .setDescription("The channel to post meeting notes in")
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const channel = interaction.options.getChannel("channel");

            // Check if the channel is a text channel
            if (channel.type !== 0) {
                // 0 is GUILD_TEXT
                return interaction.editReply("Please select a text channel.");
            }

            // Update the config file
            const configPath = path.join(__dirname, "..", "config.json");
            const config = require(configPath);

            config.meetingNotesChannelId = channel.id;

            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

            await interaction.editReply(
                `Meeting notes will now be posted in <#${channel.id}>`
            );
        } catch (error) {
            console.error("Error setting meeting channel:", error);
            await interaction.editReply("Failed to set meeting channel.");
        }
    },
};
