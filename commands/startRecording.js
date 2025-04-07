const { SlashCommandBuilder } = require("@discordjs/builders");
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    EndBehaviorType,
    entersState,
} = require("@discordjs/voice");
const { createWriteStream } = require("node:fs");
const prism = require("prism-media");
const path = require("node:path");
const fs = require("node:fs");
const { promisify } = require("node:util");
const wait = promisify(setTimeout);

// Store active recordings
const activeRecordings = new Map();

// Function to create opus decoder with fallback
function createOpusDecoder() {
    const options = {
        rate: 48000,
        channels: 2,
        frameSize: 960,
    };

    try {
        // Try @discordjs/opus first
        return new prism.opus.Decoder(options);
    } catch (err) {
        console.log(
            "Failed to create @discordjs/opus decoder, trying opusscript..."
        );
        try {
            // Try opusscript as fallback
            const OpusScript = require("opusscript");
            return new OpusScript(options.rate, options.channels);
        } catch (err2) {
            console.error(
                "Failed to create opus decoder with any available library:",
                err2
            );
            throw new Error("No opus decoder available");
        }
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("record")
        .setDescription("Join a voice channel and start recording"),

    async execute(interaction) {
        // Check if user is in a voice channel
        const voiceChannel = interaction.member.voice.channel;
        if (!voiceChannel) {
            return interaction.reply({
                content:
                    "You need to be in a voice channel to use this command!",
                ephemeral: true,
            });
        }

        // Check if already recording in this guild
        if (activeRecordings.has(interaction.guildId)) {
            return interaction.reply({
                content: "Already recording in this server!",
                ephemeral: true,
            });
        }

        await interaction.deferReply();

        try {
            // Create recordings directory if it doesn't exist
            const recordingsPath = path.join(__dirname, "..", "recordings");
            if (!fs.existsSync(recordingsPath)) {
                fs.mkdirSync(recordingsPath, { recursive: true });
            }

            console.log("Starting recording process...");
            console.log("Guild ID:", interaction.guildId);
            console.log("Guild:", interaction.guild.name);

            // Create a unique filename for this recording
            const fileName = `recording_${
                interaction.guildId
            }_${Date.now()}.pcm`;
            const filePath = path.join(recordingsPath, fileName);

            // Create a PCM stream for the recording
            const audioStream = createWriteStream(filePath);

            // Create an audio player
            const player = createAudioPlayer();

            // Join the voice channel
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: interaction.guildId,
                adapterCreator: interaction.guild.voiceAdapterCreator,
                selfDeaf: false,
            });

            // Wait for the connection to be ready
            try {
                await entersState(
                    connection,
                    VoiceConnectionStatus.Ready,
                    30_000
                );
                console.log("Voice connection is ready!");
            } catch (error) {
                connection.destroy();
                throw new Error("Failed to establish voice connection");
            }

            // Handle connection states
            connection.on(VoiceConnectionStatus.Disconnected, async () => {
                try {
                    await Promise.race([
                        entersState(
                            connection,
                            VoiceConnectionStatus.Signalling,
                            5_000
                        ),
                        entersState(
                            connection,
                            VoiceConnectionStatus.Connecting,
                            5_000
                        ),
                    ]);
                } catch (error) {
                    // If we fail to reconnect, destroy the connection and remove the recording
                    connection.destroy();
                    if (activeRecordings.has(interaction.guildId)) {
                        const recording = activeRecordings.get(
                            interaction.guildId
                        );
                        recording.audioStream.end();
                        activeRecordings.delete(interaction.guildId);
                    }
                }
            });

            // Handle connection errors
            connection.on("error", (error) => {
                console.error("Voice connection error:", error);
            });

            // Subscribe to the audio receiver
            const receiver = connection.receiver;

            // Store recording data
            const recordingData = {
                connection,
                audioStream,
                filePath,
                startTime: Date.now(),
                speakers: new Map(),
                player,
            };

            console.log(
                "Storing recording data for guild:",
                interaction.guildId
            );
            activeRecordings.set(interaction.guildId, recordingData);

            // Set up audio recording for each user
            connection.receiver.speaking.on("start", async (userId) => {
                try {
                    const user = interaction.guild.members.cache.get(userId);
                    console.log(
                        `${user?.displayName || userId} started speaking`
                    );

                    if (!activeRecordings.has(interaction.guildId)) {
                        console.log(
                            "Warning: Recording not found for guild when user started speaking"
                        );
                        return;
                    }

                    const recording = activeRecordings.get(interaction.guildId);

                    // If user already has a stream, clean it up
                    if (recording.speakers.has(userId)) {
                        try {
                            const oldStream = recording.speakers.get(userId);
                            if (oldStream.stream) oldStream.stream.destroy();
                            if (oldStream.decoder) oldStream.decoder.destroy();
                            recording.speakers.delete(userId);
                            await wait(100); // Wait a bit before creating new stream
                        } catch (err) {
                            console.error("Error cleaning up old stream:", err);
                        }
                    }

                    const userAudioStream = receiver.subscribe(userId, {
                        end: {
                            behavior: EndBehaviorType.AfterSilence,
                            duration: 500, // Increased silence duration
                        },
                    });

                    // Create opus decoder with error handling
                    let opusDecoder;
                    try {
                        opusDecoder = createOpusDecoder();
                        console.log("Successfully created opus decoder");
                    } catch (err) {
                        console.error("Failed to create opus decoder:", err);
                        userAudioStream.destroy();
                        return;
                    }

                    // Store the user's audio stream
                    recording.speakers.set(userId, {
                        stream: userAudioStream,
                        decoder: opusDecoder,
                        username: user?.displayName || userId,
                    });

                    // Set up error handlers before piping
                    userAudioStream.on("error", (error) => {
                        console.error(
                            `Error in user ${userId} audio stream:`,
                            error
                        );
                        if (recording.speakers.has(userId)) {
                            const userRecording =
                                recording.speakers.get(userId);
                            if (userRecording.decoder)
                                userRecording.decoder.destroy();
                            recording.speakers.delete(userId);
                        }
                    });

                    opusDecoder.on("error", (error) => {
                        console.error(
                            `Error in opus decoder for user ${userId}:`,
                            error
                        );
                    });

                    // Pipe the audio with error handling
                    try {
                        userAudioStream
                            .pipe(opusDecoder)
                            .pipe(recording.audioStream, { end: false });

                        console.log(
                            `Audio stream setup complete for user ${userId}`
                        );
                    } catch (err) {
                        console.error("Error setting up audio pipeline:", err);
                        if (recording.speakers.has(userId)) {
                            const userRecording =
                                recording.speakers.get(userId);
                            if (userRecording.stream)
                                userRecording.stream.destroy();
                            if (userRecording.decoder)
                                userRecording.decoder.destroy();
                            recording.speakers.delete(userId);
                        }
                    }

                    // Handle stream end
                    userAudioStream.on("end", () => {
                        console.log(`User ${userId} audio stream ended`);
                        if (recording.speakers.has(userId)) {
                            const userRecording =
                                recording.speakers.get(userId);
                            if (userRecording.decoder)
                                userRecording.decoder.destroy();
                            recording.speakers.delete(userId);
                        }
                    });
                } catch (error) {
                    console.error(
                        `Error setting up audio stream for user ${userId}:`,
                        error
                    );
                }
            });

            // Set a timeout for max meeting duration
            const config = require("../config.json");
            const maxDuration = config.maxMeetingDuration * 1000;

            setTimeout(() => {
                if (activeRecordings.has(interaction.guildId)) {
                    const recording = activeRecordings.get(interaction.guildId);
                    if (Date.now() - recording.startTime >= maxDuration) {
                        const stopCommand = require("./stopRecording");
                        stopCommand.stopRecording(
                            interaction.guild,
                            interaction.channel
                        );
                    }
                }
            }, maxDuration);

            await interaction.editReply(
                `Started recording in ${voiceChannel.name}. Use /stop to end recording.`
            );
        } catch (error) {
            console.error("Error in recording setup:", error);
            await interaction.editReply("Failed to start recording.");
        }
    },
};

// Export the map for other files to use
module.exports.activeRecordings = activeRecordings;
