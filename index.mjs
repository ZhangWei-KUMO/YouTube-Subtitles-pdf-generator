import { parseString } from 'xml2js';
import { writeFile } from 'fs/promises';

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

        const englishSubTrack = captionTracks.find(track => track.languageCode === 'en');

        if (!englishSubTrack) {
            console.error("没有找到可用的英文字幕");
            return null;
        }
        console.log("获取到字幕信息", englishSubTrack)
        return englishSubTrack.baseUrl;
    } catch (error) {
        console.error("获取视频信息出错:", error);
        return null;
    }
}

async function translateText(text) {
    const chunks = chunkString(text, MAX_CHUNK_LENGTH);
    let translatedText = '';
    for (const chunk of chunks) {
        let translationResult = await requestGoogle(chunk);
        if (translationResult && translationResult.error) {
            return translationResult.error;
        }
        // Replace '&' with '&'
        translationResult = translationResult.replace(/&/g, '&');
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

function decodeHTMLEntities(text) {
  const entities = {
    '&': '&',
    '<': '<',
    '>': '>',
    '"': '"',
    '&#39;': "'",
    '&apos;': "'",
    '`': '`',
  };
  return text.replace(/&|<|>|"|'|'|`/g, match => entities[match]);
}


async function translateAndSaveVtt(videoId) {
    const vttUrl = await getVideoInfo(videoId);
    if (!vttUrl) {
        console.error("获取字幕链接失败");
        return;
    }

    try {
        const response = await fetch(vttUrl);
        // 获取原字幕的xml内容
        let vttContent = await response.text();
          // 解码HTML实体
        vttContent = decodeHTMLEntities(vttContent);

        await writeFile(`${videoId}.raw.xml`, vttContent);

        // 获取中文字幕的xml内容
        const translatedText = await translateText(vttContent);
        await writeFile(`${videoId}.translated.xml`, translatedText);
        // 两个xml内容根据时间戳进行合并成一个xml
        const mergedXml = await mergeVttXml(vttContent, translatedText);
        // 存入文件
        await writeFile(`${videoId}.merged.xml`, mergedXml);
        // 转换成srt格式
        const srtContent = await convertXmlToSrt(mergedXml, videoId);
        // 存入文件
        await writeFile(`${videoId}.merged.srt`, srtContent);
    } catch (error) {
        console.error("处理字幕时出错:", error);
    }
}

function formatTime(seconds) {
  const date = new Date(0);
  date.setSeconds(seconds);
  const isoString = date.toISOString();
  return isoString.substring(11, 23).replace('.', ',');
}

async function convertXmlToSrt(xmlContent, videoId) {
  return new Promise((resolve, reject) => {
      parseString(xmlContent, { explicitArray: false }, (err, xml) => {
          if (err) {
              reject("Error parsing XML: " + err);
              return;
          }

          let srtContent = '';
          let index = 1;
          if (!xml || !xml.transcript || !xml.transcript.text) {
              reject("Invalid XML structure");
              return;
          }

          xml.transcript.text.forEach(cue => {
              const start = parseFloat(cue.$.start);
              const duration = parseFloat(cue.$.dur);
              const end = start + duration;
                
              const formattedStartTime = formatTime(start);
              const formattedEndTime = formatTime(end);

              const englishText = cue._ || "";
              const chineseText = cue.chinese ? cue.chinese : "";

             srtContent += `${index}\n${formattedStartTime} --> ${formattedEndTime}\n${englishText.trim()}${chineseText ? "\n" + chineseText.trim() : ""}\n\n`;

              index++;
          });

          resolve(srtContent);
      });
  });
}
async function mergeVttXml(vttContent, translatedText) {
    return new Promise((resolve, reject) => {
        parseString(vttContent, { explicitArray: false }, (err, originalXml) => {
            if (err) {
                reject("Error parsing original XML: " + err);
                return;
            }

            parseString(translatedText, { explicitArray: false }, (err, translatedXml) => {
                if (err) {
                    reject("Error parsing translated XML: " + err);
                    return;
                }
                const originalCues = originalXml.transcript.text;
                const translatedCues = translatedXml.transcript.text;
                // Create a map of start times to translated text cues.
                const translatedCueMap = new Map();
                translatedCues.forEach(cue => {
                    translatedCueMap.set(cue.$.start, cue);
                });

                let mergedText = "<?xml version=\"1.0\" encoding=\"utf-8\" ?><transcript>";

                originalCues.forEach(originalCue => {
                    const translatedCue = translatedCueMap.get(originalCue.$.start);
                    mergedText += `<text start="${originalCue.$.start}" dur="${originalCue.$.dur}" >${originalCue._}  ${translatedCue ? `<chinese>${translatedCue._}</chinese>` : ''}</text>`;
                })

                mergedText += "</transcript>";
                resolve(mergedText);
            });
        });
    });
}
// 示例用法
const videoId = 'vAL2YtZRiIY'; // 将 'your_video_id_here' 替换为实际的 YouTube 视频 ID
translateAndSaveVtt(videoId);