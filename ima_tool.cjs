/**
 * IMA 知识库工具脚本
 * 封装知识库搜索API + import_urls写入 + 文件上传
 * 
 * 用法：
 *   node ima_tool.cjs search <query>                    - 搜索知识库
 *   node ima_tool.cjs add-urls <url1,url2,...>          - 通过URL导入网页到知识库
 *   node ima_tool.cjs upload <filepath>                 - 上传文件（暂不可用）
 *   node ima_tool.cjs list                              - 列出知识库内容
 *   node ima_tool.cjs list-kb                           - 列出所有知识库
 * 
 * 注意：add_knowledge/create_media的API存在Go反序列化兼容问题，
 * 目前只有import_urls（字符串数组格式）可以成功写入知识库。
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KB_ID = 'hDUhpsDebk23DA5i2re68dmwnichwWda4j5eYos3aaM=';

function getCreds() {
  const clientIdPath = path.join(process.env.HOME || '/root', '.config', 'ima', 'client_id');
  const apiKeyPath = path.join(process.env.HOME || '/root', '.config', 'ima', 'api_key');
  const cid = fs.readFileSync(clientIdPath, 'utf8').replace(/^\uFEFF/, '').trim();
  const key = fs.readFileSync(apiKeyPath, 'utf8').replace(/^\uFEFF/, '').trim();
  return { cid, key };
}

function imaRequest(apiPath, bodyObj) {
  const { cid, key } = getCreds();
  const fullPath = apiPath.startsWith('/') ? apiPath : '/' + apiPath;
  const body = JSON.stringify(bodyObj);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'ima.qq.com',
      path: fullPath,
      method: 'POST',
      headers: {
        'ima-openapi-clientid': cid,
        'ima-openapi-apikey': key,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('解析失败: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', e => reject(e));
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('超时')); });
    req.write(body);
    req.end();
  });
}

// COS上传（PUT请求，非IMA API）
function cosUpload(uploadUrl, fileContent, contentType) {
  return new Promise((resolve, reject) => {
    // 提取host和path from URL
    const urlObj = new URL(uploadUrl);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'PUT',
      headers: {
        'Content-Type': contentType || 'text/markdown',
        'Content-Length': Buffer.byteLength(fileContent)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: data });
        } else {
          reject(new Error('COS上传失败: STATUS ' + res.statusCode + ' ' + data.substring(0, 200)));
        }
      });
    });
    req.on('error', e => reject(e));
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('COS上传超时')); });
    req.write(fileContent);
    req.end();
  });
}

// 上传文件到IMA知识库的完整三步流程
async function uploadFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error('文件不存在: ' + filePath);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const fileName = path.basename(filePath);
  const fileSize = Buffer.byteLength(content);

  console.log('上传文件:', fileName, '大小:', fileSize, '字节');

  // Step 1: create_media - 获取COS上传URL和file_id
  console.log('Step 1: 获取上传凭证...');
  const createResult = await imaRequest('/openapi/wiki/v1/create_media', {
    knowledge_base_id: KB_ID,
    title: fileName,
    media_type: 1,
    file_size: fileSize
  });

  if (createResult.code !== 0) {
    throw new Error('create_media失败: ' + createResult.msg);
  }

  const uploadUrl = createResult.data.upload_url;
  const fileId = createResult.data.file_id;

  console.log('上传URL获取成功, file_id:', fileId);

  // Step 2: COS上传文件内容
  console.log('Step 2: 上传文件内容到COS...');
  const contentType = fileName.endsWith('.md') ? 'text/markdown' :
                      fileName.endsWith('.json') ? 'application/json' : 'application/octet-stream';
  await cosUpload(uploadUrl, content, contentType);
  console.log('COS上传成功');

  // Step 3: add_knowledge - 告知IMA文件已上传
  console.log('Step 3: 添加知识库记录...');
  const addResult = await imaRequest('/openapi/wiki/v1/add_knowledge', {
    knowledge_base_id: KB_ID,
    media_type: 1,
    media_info: {
      file_id: fileId,
      title: fileName
    }
  });

  if (addResult.code !== 0) {
    throw new Error('add_knowledge失败: ' + addResult.msg);
  }

  console.log('✅ 上传完成! 文件已添加到知识库');
  return addResult;
}

// 搜索知识库
async function searchKB(query) {
  const result = await imaRequest('/openapi/wiki/v1/search_knowledge', {
    query: query,
    knowledge_base_id: KB_ID,
    cursor: ''
  });

  if (result.code !== 0) {
    throw new Error('搜索失败: ' + result.msg);
  }

  const items = result.data.info_list || [];
  if (items.length === 0) {
    console.log('未找到匹配内容');
  } else {
    console.log('找到', items.length, '条结果:');
    items.forEach((item, i) => {
      console.log('[' + (i+1) + '] ' + item.title);
      if (item.highlight_content) {
        console.log('    摘要: ' + item.highlight_content.substring(0, 150));
      }
    });
  }
  return result;
}

// 列出知识库内容
async function listKB() {
  const result = await imaRequest('/openapi/wiki/v1/get_knowledge_list', {
    knowledge_base_id: KB_ID,
    cursor: '',
    limit: 50
  });

  if (result.code !== 0) {
    throw new Error('列出失败: ' + result.msg);
  }

  const items = result.data.info_list || [];
  console.log('知识库内容 (' + items.length + '条):');
  items.forEach((item, i) => {
    console.log('[' + (i+1) + '] ' + item.title + ' | 类型:' + item.media_type + ' | ID:' + (item.content_id || item.file_id || '').substring(0,20));
  });
  return result;
}

// 列出所有知识库
async function listAllKB() {
  const result = await imaRequest('/openapi/wiki/v1/search_knowledge_base', {
    query: '',
    cursor: '',
    limit: 20
  });

  if (result.code !== 0) {
    throw new Error('列出知识库失败: ' + result.msg);
  }

  const kbs = result.data.info_list || [];
  console.log('知识库列表 (' + kbs.length + '个):');
  kbs.forEach((kb, i) => {
    console.log('[' + (i+1) + '] ' + kb.kb_name + ' | 内容:' + kb.content_count + '条 | ID:' + kb.kb_id.substring(0,20));
  });
  return result;
}

// 通过import_urls添加网页到知识库（当前唯一可用的写入方式）
async function addUrls(urlList) {
  const result = await imaRequest('/openapi/wiki/v1/import_urls', {
    knowledge_base_id: KB_ID,
    urls: urlList
  });

  if (result.code !== 0) {
    throw new Error('import_urls失败: ' + result.msg);
  }

  const results = result.data.results || {};
  const successCount = Object.values(results).filter(r => r.ret_code === 0).length;
  const failCount = Object.values(results).filter(r => r.ret_code !== 0).length;
  console.log('✅ 导入完成! 成功:', successCount, '失败:', failCount);
  Object.entries(results).forEach(([url, info]) => {
    if (info.ret_code === 0) {
      console.log('  ✅ ' + url + ' → media_id:', info.media_id.substring(0, 30));
    } else {
      console.log('  ❌ ' + url + ' → ret_code:', info.ret_code);
    }
  });
  return result;
}

// 命令行入口
async function main() {
  const action = process.argv[2];
  const param = process.argv[3];

  try {
    switch (action) {
      case 'search':
        await searchKB(param || '创新药');
        break;
      case 'add-urls':
        if (!param) { console.error('请提供URL列表，用逗号分隔'); process.exit(1); }
        await addUrls(param.split(','));
        break;
      case 'upload':
        if (!param) { console.error('请提供文件路径'); process.exit(1); }
        await uploadFile(param);
        break;
      case 'list':
        await listKB();
        break;
      case 'list-kb':
        await listAllKB();
        break;
      default:
        console.log('用法: node ima_tool.cjs <action> [param]');
        console.log('  search <query>          - 搜索知识库');
        console.log('  add-urls <url1,url2,...> - 导入网页到知识库');
        console.log('  upload                  - 文件上传（暂不可用）');
        console.log('  list                    - 列出知识库内容');
        console.log('  list-kb                 - 列出所有知识库');
    }
  } catch (e) {
    console.error('❌ 错误:', e.message);
    process.exit(1);
  }
}

main();
