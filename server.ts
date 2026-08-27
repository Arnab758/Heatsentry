import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Modality } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

// In-memory audio cache to provide 0ms instant playback on repeat or pre-buffered alert requests
const audioCache = new Map<string, Buffer>();

// Helper to convert 16-bit PCM audio (sampleRate 24kHz) to valid WAV buffer
function pcmToWav(pcmBuffer: Buffer, sampleRate = 24000, numChannels = 1, bitDepth = 16): Buffer {
  const byteRate = (sampleRate * numChannels * bitDepth) / 8;
  const blockAlign = (numChannels * bitDepth) / 8;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  // RIFF chunk descriptor
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);

  // "fmt " sub-chunk
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // 16 for PCM
  header.writeUInt16LE(1, 20); // 1 = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);

  // "data" sub-chunk
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "5mb" }));

  // Health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", service: "HeatSentry Audio & Twin Engine" });
  });

  // Fast AI High-Fidelity Multilingual TTS Endpoint
  app.post("/api/tts", async (req, res) => {
    try {
      const { text, lang } = req.body;
      if (!text || typeof text !== "string") {
        return res.status(400).json({ error: "Text is required" });
      }

      const languageCode = (lang || "EN").toUpperCase();
      // Keep concise payload for low-latency synthesis
      const cleanText = text.trim();
      const cacheKey = `${languageCode}:${cleanText}`;

      // Check fast in-memory cache first
      if (audioCache.has(cacheKey)) {
        const cachedWav = audioCache.get(cacheKey)!;
        res.setHeader("Content-Type", "audio/wav");
        res.setHeader("Content-Length", cachedWav.length.toString());
        res.setHeader("X-Cache", "HIT");
        return res.send(cachedWav);
      }

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: "GEMINI_API_KEY is not configured" });
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });

      let voiceName = "Kore";
      if (languageCode === "AR" || languageCode.startsWith("AR")) {
        voiceName = "Kore";
      } else if (languageCode === "HI" || languageCode.startsWith("HI")) {
        voiceName = "Zephyr";
      } else {
        voiceName = "Zephyr";
      }

      // Directly pass text to flash-tts-preview without wrapping in heavy prompt instructions
      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-tts-preview",
        contents: [{ parts: [{ text: cleanText }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) {
        throw new Error("No audio payload returned from Gemini TTS engine");
      }

      const rawPcm = Buffer.from(base64Audio, "base64");
      const wavBuffer = pcmToWav(rawPcm, 24000, 1, 16);

      // Save to cache (limit size to 100 entries)
      if (audioCache.size > 100) {
        const firstKey = audioCache.keys().next().value;
        if (firstKey) audioCache.delete(firstKey);
      }
      audioCache.set(cacheKey, wavBuffer);

      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Content-Length", wavBuffer.length.toString());
      res.setHeader("X-Cache", "MISS");
      res.send(wavBuffer);
    } catch (error: any) {
      console.error("TTS generation error:", error?.message || error);
      res.status(500).json({
        error: "Failed to generate speech audio",
        details: error?.message || String(error),
      });
    }
  });

  // Vite development vs production static handling
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`HeatSentry Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
