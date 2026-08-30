import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';

const systemInstruction = `You are WeatherGPT, a flood alert assistant for Hyderabad, India. You have access to real-time weather data AND live web search results. Always answer about flood risk, road safety, wait times, and safe routes. Keep answers short, clear, and actionable (2-4 sentences). Reply in the same language the user writes in — English, Hindi, or Telugu. Prefer the LIVE WEATHER DATA for current conditions and the WEB SEARCH RESULTS for news, road closures, and local reports. When you use a web result, mention the source briefly. Never invent facts — only use the data provided.`;

type YouWebResult = {
  url?: string;
  title?: string;
  description?: string;
  snippets?: string[];
};

// you.com Search API — current endpoint is POST/GET https://ydc-index.io/v1/search
// (the old https://api.ydc-index.io/search now returns 403). Response shape is
// { results: { web: [{ url, title, description, snippets }] } }.
async function searchYouCom(query: string): Promise<string> {
  const apiKey = process.env.YOU_API_KEY;
  if (!apiKey) return '';

  // Don't let a slow search stall the whole chat response.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(
      `https://ydc-index.io/v1/search?query=${encodeURIComponent(query)}`,
      {
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      }
    );

    if (!res.ok) return '';

    const data = await res.json();
    const web: YouWebResult[] = data?.results?.web ?? [];

    return web
      .slice(0, 5)
      .map((hit) => {
        const title = hit.title || '';
        const detail = hit.description || hit.snippets?.[0] || '';
        const source = hit.url ? ` (${hit.url})` : '';
        return title || detail ? `- ${title}: ${detail}${source}` : '';
      })
      .filter(Boolean)
      .join('\n');
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ reply: 'Chat service is not configured.' }, { status: 200 });
    }

    const { message, weather, language } = await req.json();

    // Search you.com for live Hyderabad flood/weather news
    const searchQuery = `Hyderabad ${weather?.area ? weather.area + ' ' : ''}flood weather road conditions today ${message || ''}`;
    const webResults = await searchYouCom(searchQuery);

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.5-flash-lite',
      systemInstruction: systemInstruction,
    });

    const prompt = `
LIVE WEATHER DATA:
Area: ${weather?.area || 'Hyderabad'}
Rainfall: ${weather?.rainfall ?? 0} mm/hr
Flood Risk: ${weather?.risk || 'safe'}
Forecast next 90 mins: ${JSON.stringify(weather?.forecast || [])}

${webResults ? `LIVE WEB SEARCH RESULTS (from you.com):
${webResults}` : 'No web results available — answer from the weather data only.'}

User language: ${language || 'English'}
User question: ${message || ''}

Answer based on the weather data and web results above. Be specific and actionable.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    return NextResponse.json({ reply: text }, { status: 200 });
  } catch (error) {
    console.error('Chat API Error:', error);
    return NextResponse.json({
      reply: 'I am unable to process your request right now. Please try again.'
    }, { status: 200 });
  }
}
