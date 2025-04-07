const { SlashCommandBuilder } = require("@discordjs/builders");
const { getVoiceConnection } = require("@discordjs/voice");
const { activeRecordings } = require("./startRecording");
const fs = require("node:fs");
const path = require("node:path");
const { transcribeAudio } = require("../utils/transcription");
const { summarizeMeeting } = require("../utils/summarization");
const { promisify } = require("node:util");
const wait = promisify(setTimeout);
const config = require("../config.json");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("stop")
        .setDescription("Stop recording and generate transcript"),

    async execute(interaction) {
        await interaction.deferReply();
        await this.stopRecording(
            interaction.guild,
            interaction.channel,
            interaction
        );
    },

    async stopRecording(guild, textChannel, interaction = null) {
        console.log("Stop recording called");
        console.log("Guild ID:", guild.id);
        console.log("Guild name:", guild.name);
        console.log(
            "Active recordings at stop:",
            Array.from(activeRecordings.keys())
        );

        // Check if recording exists
        if (!activeRecordings.has(guild.id)) {
            const response = "No active recording found in this server.";
            console.log(`No recording found for guild ${guild.id}`);
            if (interaction) {
                await interaction.editReply(response);
            } else {
                await textChannel.send(response);
            }
            return;
        }

        try {
            const recording = activeRecordings.get(guild.id);
            console.log("Found recording data:", {
                hasConnection: !!recording.connection,
                hasAudioStream: !!recording.audioStream,
                filePath: recording.filePath,
                startTime: recording.startTime,
                speakerCount: recording.speakers.size,
            });

            // Close all user audio streams
            console.log(
                `Closing ${recording.speakers.size} user audio streams`
            );
            for (const [userId, userRecording] of recording.speakers) {
                console.log(`Closing stream for user ${userId}`);
                try {
                    userRecording.stream.destroy();
                } catch (err) {
                    console.error(
                        `Error closing stream for user ${userId}:`,
                        err
                    );
                }
            }

            // Wait a bit for any final audio data to be written
            await wait(1000);

            // Close the main audio stream
            console.log("Closing main audio stream");
            try {
                recording.audioStream.end();
                await wait(500); // Wait for the stream to finish
            } catch (err) {
                console.error("Error closing main audio stream:", err);
            }

            // Disconnect from voice
            console.log("Destroying voice connection");
            try {
                if (recording.player) {
                    recording.player.stop();
                }
                recording.connection.destroy();
            } catch (err) {
                console.error("Error destroying voice connection:", err);
            }

            // Remove from active recordings
            console.log("Removing from active recordings");
            activeRecordings.delete(guild.id);

            const response = "Recording stopped. Processing audio...";
            if (interaction) {
                await interaction.editReply(response);
            } else {
                await textChannel.send(response);
            }

            // Check if the file exists and has content
            if (!fs.existsSync(recording.filePath)) {
                throw new Error("Recording file not found");
            }

            const fileStats = fs.statSync(recording.filePath);
            if (fileStats.size === 0) {
                throw new Error("Recording file is empty");
            }

            // Create transcripts directory if it doesn't exist
            const transcriptsDir = path.join(__dirname, "..", "transcripts");
            if (!fs.existsSync(transcriptsDir)) {
                fs.mkdirSync(transcriptsDir, { recursive: true });
            }

            // Convert PCM to MP3 for transcription
            const mp3FilePath = recording.filePath.replace(".pcm", ".mp3");
            await convertToWav(recording.filePath, mp3FilePath);

            // Check if MP3 file was created successfully
            if (!fs.existsSync(mp3FilePath)) {
                throw new Error("MP3 conversion failed");
            }

            const mp3FileStats = fs.statSync(mp3FilePath);
            if (mp3FileStats.size === 0) {
                throw new Error("Converted MP3 file is empty");
            }

            // Check file size (25MB limit)
            const maxSize = 25 * 1024 * 1024; // 25MB in bytes
            if (mp3FileStats.size > maxSize) {
                throw new Error("Audio file too large. Maximum size is 25MB.");
            }

            // Transcribe the audio
            const statusMessage = interaction
                ? await interaction.followUp("Transcribing audio...")
                : await textChannel.send("Transcribing audio...");

            const transcript = await transcribeAudio(mp3FilePath);

            // Generate summary
            await statusMessage.edit("Generating meeting summary...");
            const summary = await summarizeMeeting(transcript);

            // Save transcript and summary
            const transcriptFilePath = path.join(
                transcriptsDir,
                `transcript_${guild.id}_${recording.startTime}.txt`
            );
            const summaryFilePath = path.join(
                transcriptsDir,
                `summary_${guild.id}_${recording.startTime}.txt`
            );

            fs.writeFileSync(transcriptFilePath, transcript);
            fs.writeFileSync(summaryFilePath, summary);

            // Send results
            await statusMessage.edit("Meeting recording processed!");

            // Get the meeting notes channel if configured
            let notesChannel = textChannel;
            if (config.meetingNotesChannelId) {
                try {
                    const meetingNotesChannel = await guild.channels.fetch(config.meetingNotesChannelId);
                    if (meetingNotesChannel) {
                        notesChannel = meetingNotesChannel;
                        console.log(`Using meeting notes channel: ${meetingNotesChannel.name}`);
                        
                        // Notify the command channel that results are posted elsewhere
                        if (textChannel.id !== notesChannel.id) {
                            await textChannel.send(`Meeting summary and transcript have been posted in <#${notesChannel.id}>`);
                        }
                    }
                } catch (err) {
                    console.error("Error fetching meeting notes channel:", err);
                    console.log("Falling back to original text channel");
                }
            }

            // Send the summary and transcript to the appropriate channel
            await notesChannel.send({
                content: "**Meeting Summary:**",
                files: [summaryFilePath],
            });

            await notesChannel.send({
                content: "**Full Transcript:**",
                files: [transcriptFilePath],
            });

            // Clean up audio files
            try {
                fs.unlinkSync(recording.filePath);
                fs.unlinkSync(mp3FilePath);
            } catch (err) {
                console.error("Error cleaning up audio files:", err);
            }
        } catch (error) {
            console.error("Error in stopRecording:", error);
            const errorMsg =
                "An error occurred while processing the recording.";
            if (interaction) {
                await interaction.editReply(errorMsg);
            } else {
                await textChannel.send(errorMsg);
            }
        }
    },
};

// Helper function to convert PCM to WAV
async function convertToWav(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const { spawn } = require("node:child_process");
        const ffmpegPath = require("ffmpeg-static");

        const ffmpeg = spawn(ffmpegPath, [
            "-f",
            "s16le",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-i",
            inputPath,
            "-c:a",
            "libmp3lame",
            "-b:a",
            "64k",
            "-ar",
            "16000",
            "-y",
            outputPath.replace(".wav", ".mp3"),
        ]);

        ffmpeg.on("close", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`FFmpeg process exited with code ${code}`));
            }
        });

        ffmpeg.stderr.on("data", (data) => {
            console.log(`FFmpeg: ${data}`);
        });

        ffmpeg.on("error", (error) => {
            reject(error);
        });
    });
}
