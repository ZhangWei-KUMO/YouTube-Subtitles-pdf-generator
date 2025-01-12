import express from 'express';
import { parseString } from 'xml2js';
import { writeFile } from 'fs/promises';
import ytdl from '@distube/ytdl-core';
import fetch from 'node-fetch';
import fs from 'fs';

const app = express();
const port = 3000;
const MAX_CHUNK_LENGTH = 10000;

app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // 设置静态资源目录
app.set('view engine', 'ejs'); // 设置模板引擎

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
         // 先把所有 & 替换为 &
         translationResult = translationResult.replace(/&/g, '&');
        // 删除特殊字符<200b><200c><200d>
        translationResult = translationResult.replace(/[\u200B-\u200D\uFEFF]/g, '');
        // 转换&#39;s为'
        translationResult = translationResult.replace(/&#39;/g, "'");
         // 转义 <, >, "
         translationResult = translationResult.replace(/</g, '<')
         translationResult = translationResult.replace(/>/g, '>')
         translationResult = translationResult.replace(/"/g, '"')
          // 删除其他XML无法解析的控制字符
          translationResult = translationResult.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
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
    "'": "'",
    "'": "'",
    '`': '`',
};
return text.replace(/&|<|>|"|'|'|`/g, match => entities[match]);
}


async function translateAndSaveVtt(youtubeUrl, res) {
    // 截取youtube视频id
    const videoId = youtubeUrl.split('v=')[1];
    const vttUrl = await getVideoInfo(videoId);
    if (!vttUrl) {
        console.error("获取字幕链接失败");
        res.render('index', { error: '获取字幕链接失败' });
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
        // 存储
        const fileName2 = `${videoId}.translated.xml`
        await writeFile(fileName2, translatedText);
        // 两个xml内容根据时间戳进行合并成一个xml
        const mergedXml = await mergeVttXml(vttContent, translatedText);
        // 转换成srt格式
        const srtContent = await convertXmlToSrt(mergedXml, videoId);
        // 存入文件
        const fileName = `${videoId}.merged.srt`
        await writeFile(fileName, srtContent);
        res.download(fileName, fileName, (err) => {
          if (err) {
            console.error("下载文件出错:", err);
            fs.unlink(fileName,(unlinkErr)=>{
                if(unlinkErr){
                    console.error("删除文件失败", unlinkErr)
                }
              });
              res.render('index', { error: '下载文件出错' });
          }else{
            fs.unlink(fileName,(unlinkErr)=>{
                if(unlinkErr){
                    console.error("删除文件失败", unlinkErr)
                }
              });
          }
       });
    } catch (error) {
        console.error("处理字幕时出错:", error);
        res.render('index', { error: '处理字幕时出错' });
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

// 主页路由
app.get('/', (req, res) => {
    res.render('index', { error: null });
});

// 处理字幕请求的路由
app.post('/generate-subtitle', async (req, res) => {
    const youtubeUrl = req.body.youtubeUrl;
    if (!youtubeUrl) {
        res.render('index', { error: '请提供 YouTube 链接' });
        return;
    }
    try{
        await translateAndSaveVtt(youtubeUrl, res);
        // let video = await downloadYouTubeVideo(youtubeUrl);
    }catch(e){
        console.error("出错", e)
         res.render('index', { error: '出现错误, 请查看控制台' });
    }
});

app.post('/generate-downloadlink', async (req, res) => {
    const youtubeUrl = req.body.youtubeUrl;
    if (!youtubeUrl) {
        res.render('index', { error: '请提供 YouTube 链接' });
        return;
    }
    try{
        let video = await downloadYouTubeVideo(youtubeUrl);
        if(video){
            res.json({success: true, video: video});
        }else{
            res.json({success: false, error: "获取视频信息失败"});
        }
    }catch(e){
        console.error("出错", e)
         res.render('index', { error: '出现错误, 请查看控制台' });
    }
});

app.listen(port, () => {
    console.log(`服务器运行在 http://localhost:${port}`);
});