import express from 'express';
import { parseString } from 'xml2js';
import { writeFile } from 'fs/promises';
import ytdl from '@distube/ytdl-core';
import fetch from 'node-fetch';
import fs from 'fs';

const app = express();
const port = 3000;
const MAX_GOOGLE_TRANSLATE_LENGTH = 10000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');

async function downloadYouTubeVideo(youtubeUrl) {
 try {
     let res = await ytdl.getBasicInfo(youtubeUrl)
     let videoDetails = res.videoDetails
     let videoTitle = videoDetails.title
     let videoAuthor = videoDetails.author.name
     let {formats} = await ytdl.getInfo(youtubeUrl);
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

function formatTime(seconds) {
    const date = new Date(0);
    date.setSeconds(seconds);
    const isoString = date.toISOString();
    return isoString.substring(11, 23).replace('.', ',');
}

function decodeHTMLEntities(text) {
    const entities = {
    '&': '&',
    '<': '<',
    '>': '>',
    '"': '"',
    "'": "'",
    "'": "'",
    '': '',
    };
    return text.replace(/&|<|>|"|'|'|`/g, match => entities[match]);
}

async function convertXmlToSrt(xmlContent) {
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
                let englishText = cue._ ? decodeHTMLEntities(cue._).replace(/\n/g, ' ') : ""; 
                // 处理&#39;
                englishText = englishText.replace(/&#39;/g, "'");
                srtContent += `${index}\n${formattedStartTime} --> ${formattedEndTime}\n${englishText.trim()}\n\n`;
                index++;
            });
            resolve(srtContent);
        });
    });
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
        return englishSubTrack.baseUrl;
    } catch (error) {
        console.error("获取视频信息出错:", error);
        return null;
    }
}


function escapeXML(str) {
  return String(str)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '\'');
}

function chunkString(str, size) {
    const numChunks = Math.ceil(str.length / size);
    const chunks = new Array(numChunks);
    
    for (let i = 0, o = 0; i < numChunks; ++i, o += size) {
        chunks[i] = str.substr(o, size);
    }
    return chunks;
}



async function translateAndSaveVtt(youtubeUrl, res) {
    const videoId = youtubeUrl.split('v=')[1];
    const vttUrl = await getVideoInfo(videoId);
    if (!vttUrl) {
        console.error("获取字幕链接失败");
        res.render('index', { error: '获取字幕链接失败' });
        return;
    }

    try {
        const response = await fetch(vttUrl);
        // 获取到xml内容
        let vttContent = await response.text();
        let srtContent = await convertXmlToSrt(vttContent);
 
        const srtChunks = chunkString(srtContent, MAX_GOOGLE_TRANSLATE_LENGTH)

        let translatedSrtContent = '';
        for(const srtChunk of srtChunks){
                // 分块翻译，得到结果
             let translatedTextChunk = await requestGoogle(srtChunk)
             translatedSrtContent += translatedTextChunk;
        }
      
        const englishSrtLines = srtContent.trim().split('\n\n');
        const translatedLines = translatedSrtContent.trim().split('\n\n');

         // 3. 初始化合并后的 SRT 内容字符串
        let mergedSrtContent = '';

        // 4. 遍历英文字幕块，合并中文字幕
        for (let i = 0; i < englishSrtLines.length; i++) {
            const originalLine = englishSrtLines[i];
            const translatedLine = translatedLines[i];
            const originalParts = originalLine.split('\n');
            const translatedPart = translatedLine ? translatedLine.split('\n')[2] : "";
            mergedSrtContent += `${originalParts[0]}\n${originalParts[1]}\n${originalParts[2]}${translatedPart ? `\n${translatedPart}` : ''}\n\n`;
        }
        // 将合并后的 SRT 文件提供给前端浏览器下载
        res.setHeader('Content-Disposition', `attachment; filename="subtitle.srt"`);
        res.setHeader('Content-Type', 'text/plain');
        res.send(mergedSrtContent);
        
    } catch (error) {
        console.error("处理字幕时出错:", error);
        res.render('index', { error: '处理字幕时出错' });
    }
}



app.get('/', (req, res) => {
    res.render('index', { error: null });
});

app.get('/download', (req, res) => {
    res.render('download', { error: null });
});


app.post('/generate-subtitle', async (req, res) => {
    const youtubeUrl = req.body.youtubeUrl;
    if (!youtubeUrl) {
        res.render('index', { error: '请提供 YouTube 链接' });
        return;
    }
    try{
        await translateAndSaveVtt(youtubeUrl, res);
    }catch(e){
        console.error("出错", e)
         res.render('index', { error: '出现错误, 请查看控制台' });
    }
});

app.post('/generate-downloadlink', async (req, res) => {
    const youtubeUrl = req.body.youtubeUrl;
    if (!youtubeUrl) {
       return res.json({ success: false, error: '请提供 YouTube 链接' });
    }
    try{
        let video = await downloadYouTubeVideo(youtubeUrl);
           if (video && video.url) {
             // 添加 Content-Disposition 头，强制下载
            res.setHeader('Content-Disposition', `attachment; filename="${video.title}.${video.container}"`);
            res.json({ success: true, video: {
                ...video,
                 downloadUrl:video.url
            }});
        }else{
            res.json({success: false, error: "获取视频信息失败"});
        }
    }catch(e){
        console.error("出错", e)
       res.status(500).json({ success: false, error: '出现错误, 请查看控制台' });
    }
});

app.listen(port, () => {
    console.log(`服务器运行在 http://localhost:${port}`);
});