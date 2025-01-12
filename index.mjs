import { parseString } from 'xml2js';
import { writeFile } from 'fs/promises';
import ytdl from '@distube/ytdl-core';
import fs from 'fs';
const MAX_CHUNK_LENGTH = 10000;


async function downloadYouTubeVideo(youtubeUrl) {
  try {
    let res = await ytdl.getBasicInfo(youtubeUrl)
    let videoDetails = res.videoDetails
    let videoTitle = videoDetails.title
    let videoAuthor = videoDetails.author.name
    let {formats} = await ytdl.getInfo(youtubeUrl);
    // 请过滤掉mimeType中不包含video的格式
    formats = formats.filter(format => format.hasAudio===true && format.hasVideo===true);
    if(formats.length===0){
      return null
    }else{
      let video = formats[0];
      video.title = videoTitle;
      video.author = videoAuthor;
      return video
    }
  }catch(e){
    console.error("获取视频信息失败", e)
  }
}

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
        // 检查字符串中是否存在不可见空格
        if (translationResult && translationResult.error) {
            return translationResult.error;
        }
        // Replace '&' with '&'
        translationResult = translationResult.replace(/&/g, '&');
        // 删除特殊字符<200b><200c><200d>
        translationResult = translationResult.replace(/[\u200B-\u200D\uFEFF]/g, '');
        // 转换&amp;#39;s为'
        translationResult = translationResult.replace(/&amp;#39;/g, "'");
        translatedText += translationResult.trim();

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


async function translateAndSaveVtt(youtubeUrl) {
   // 截取youtube视频id
    const videoId = youtubeUrl.split('v=')[1];
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
        // 获取中文字幕的xml内容
        let translatedText = await translateText(vttContent);
        // 两个xml内容根据时间戳进行合并成一个xml
        const mergedXml = await mergeVttXml(vttContent, translatedText);
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

const youtubeUrl = 'https://www.youtube.com/watch?v=EOZYI3F1g7c';

try{
  await translateAndSaveVtt(youtubeUrl);
  let video = await downloadYouTubeVideo(youtubeUrl);
  console.log(video)
}catch(e){
  console.error("出错", e)
}

