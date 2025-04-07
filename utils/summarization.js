const axios = require("axios");
const config = require("../config.json");

async function summarizeMeeting(transcript) {
    try {
        const response = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
                model: "gpt-3.5-turbo",
                messages: [
                    {
                        role: "system",
                        content:
                            "You are an AI assistant that creates concise meeting summaries. Extract key points, action items, decisions made, and important discussions.",
                    },
                    {
                        role: "user",
                        content: `Please summarize this meeting transcript:\n\n${transcript}`,
                    },
                ],
                temperature: 0.3,
                max_tokens: 1000,
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                    "Content-Type": "application/json",
                },
            }
        );

        return response.data.choices[0].message.content;
    } catch (error) {
        console.error(
            "Summarization error:",
            error.response?.data || error.message
        );
        return "Failed to generate meeting summary. Please check the transcript.";
    }
}

module.exports = { summarizeMeeting };
