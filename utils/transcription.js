// Add this at the top of the file
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const axios = require("axios");
const FormData = require("form-data");
const config = require("../config.json");

async function transcribeAudio(filePath) {
    // Using OpenAI's Whisper API for transcription
    if (config.transcriptionService === "whisper") {
        return transcribeWithWhisper(filePath);
    } else {
        // Fallback to another service if needed
        return transcribeWithWhisper(filePath);
    }
}

async function transcribeWithWhisper(filePath) {
    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath));
    formData.append("model", "whisper-1");

    try {
        const response = await axios.post(
            "https://api.openai.com/v1/audio/transcriptions",
            formData,
            {
                headers: {
                    ...formData.getHeaders(),
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                },
            }
        );

        return response.data.text;
    } catch (error) {
        console.error(
            "Transcription error:",
            error.response?.data || error.message
        );
        throw new Error("Failed to transcribe audio");
    }
}

module.exports = { transcribeAudio };
