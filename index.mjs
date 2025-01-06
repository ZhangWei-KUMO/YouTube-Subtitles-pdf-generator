import { parseString } from 'xml2js';
import { writeFile } from 'fs/promises';
import { generatePdf } from 'html-pdf-node';

const MAX_CHUNK_LENGTH = 10000;

async function requestGoogle(rawContent) {
  const from = 'en';
  const lang = 'zh-CN';
  if (from === null) {
    return { error: 'Unsupported source language.' };
  }
  if (from === lang) {
    return '';
  }
  const googleTranslate = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${lang}&hl=${lang}&dt=t&dj=1&source=icon&tk=946553.946553&q=`;

  try {
    const res = await fetch(googleTranslate + encodeURIComponent(rawContent));
    const data = await res.json();
    let str = '';
    data.sentences.forEach((element) => {
      str += element.trans;
    });
    return str;
  } catch (e) {
    console.error('Google翻译请求失败', e);
    return { error: 'Google Translate request failed. Please check your network or try another translation engine.' };
  }
}

async function getVideoInfo(videoId) {
  try {
    const videoPageResponse = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
    const videoPageHtml = await videoPageResponse.text();
    const splittedHtml = videoPageHtml.split('"captions":');
    if (splittedHtml.length < 2) {
      console.error("无法找到字幕信息");
      return null;
    }
    const { playerCaptionsTracklistRenderer } = JSON.parse(splittedHtml[1].split(',"videoDetails')[0].replace('\n', ''));
    const { captionTracks } = playerCaptionsTracklistRenderer;
    if (!captionTracks || captionTracks.length === 0) {
      console.error("没有找到可用的英文字幕");
      return null;
    }

    const englishSubUrl = captionTracks.find(track => track.languageCode === 'en')?.baseUrl;

    if (!englishSubUrl) {
      console.error("没有找到可用的英文字幕");
      return null;
    }

    return englishSubUrl;
  } catch (error) {
    console.error("获取视频信息出错:", error);
    return null;
  }
}

async function parseXml(xmlUrl) {
  try {
    const response = await fetch(xmlUrl);
    const xmlData = await response.text();

    return new Promise((resolve, reject) => {
      parseString(xmlData, { explicitArray: false }, (err, result) => {
        if (err) {
          reject(err);
        } else {
          const cues = result?.transcript?.text;
          resolve(cues);
        }
      });
    });
  } catch (error) {
    console.error("解析 XML 时出错：", error);
    return null;
  }
}


async function translateText(text) {
  const chunks = chunkString(text, MAX_CHUNK_LENGTH);
  let translatedText = '';
  for (const chunk of chunks) {
    const translationResult = await requestGoogle(chunk);
    if (translationResult && translationResult.error) {
      return translationResult.error
    }
    translatedText += translationResult;
  }
  return translatedText;
}


function chunkString(str, size) {
  const numChunks = Math.ceil(str.length / size);
  const chunks = new Array(numChunks);

  for (let i = 0, o = 0; i < numChunks; ++i, o += size) {
    chunks[i] = str.substr(o, size);
  }

  return chunks;
}

async function createDualSubtitles(videoId) {
  const xmlUrl = await getVideoInfo(videoId);
  if (!xmlUrl) {
    console.error("获取字幕链接失败")
    return;
  }

  const cues = await parseXml(xmlUrl);
  if (!cues) {
    console.error("解析字幕内容失败")
    return;
  }

  let rawContent = '';
    // 替换所有换行符为 空格
  for (const cue of cues) {
        if (!cue || !cue._) continue;
        let englishText = cue._;
      englishText = englishText.replace(/[\n\r]+/g, ' ');
        rawContent += `${englishText} `;
  }

  const translatedText = await translateText(rawContent);

  // 优化后的英文句子分割正则表达式
  const englishSentences = rawContent.split(/(?<!\b\w\.)(?<=[.?!])\s+/).filter(Boolean);
  // 使用更全面的正则表达式分割中文句子
  const chineseSentences = translatedText.split(/(?<=[。？！])\s*/).filter(Boolean);

  let combinedContent = '';
  let filteredSentences = [];
    for (let i = 0; i < englishSentences.length; i++) {
        const englishSentence = englishSentences[i].trim();
        const chineseSentence = chineseSentences[i]?.trim() || '';
        
        if (chineseSentence.length > 10) {
           filteredSentences.push({englishSentence,chineseSentence});
       }
    }


     for (const {englishSentence, chineseSentence} of filteredSentences) {
        combinedContent += `
          <div style="display: flex; margin-bottom: 10px;">
            <div style="flex: 1; padding-right: 10px;" class="english">${englishSentence}</div>
            <div style="flex: 1; padding-left: 10px;" class="chinese">${chineseSentence}</div>
          </div>
      `;
  }
    

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>YouTube Subtitles</title>
      <style>
        body { font-family: sans-serif; }
        .header { font-size: 18px; font-weight: bold; text-align: center; margin-bottom: 20px; }
        .subheader { font-size: 14px; font-weight: bold; margin-top: 10px; margin-bottom: 5px; }
        .english { font-size: 12px; line-height: 1.5; word-wrap: break-word; }
        .chinese { font-size: 12px; line-height: 1.5; word-wrap: break-word; }
      </style>
    </head>
    <body>
      <div class="header">YouTube 视频字幕 (视频ID: ${videoId})</div>
      <div class="subheader">双语字幕:</div>
      ${combinedContent}
    </body>
    </html>
  `;

  try {
    let options = { format: 'A4', args: ['--no-sandbox', '--disable-setuid-sandbox'] };
    const pdfBuffer = await generatePdf({ content: htmlContent }, options);
    await writeFile(`subtitles_${videoId}.pdf`, pdfBuffer);
    console.log(`字幕已保存到 subtitles_${videoId}.pdf`);
  } catch (error) {
    console.error("生成 PDF 文件时出错:", error);
  }
}
// 使用示例
const videoId = 'vAL2YtZRiIY';
createDualSubtitles(videoId);