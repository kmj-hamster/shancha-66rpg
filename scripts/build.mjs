import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.resolve(root, 'dist');
const runtimeFiles = [
  'index.html', 'manifest.json', 'sw.js', 'icon-192.png', 'icon-512.png',
  'assets', 'css', 'data', 'js', 'sound'
];
const megabyte = 1024 * 1024;

function requireInside(directory, filename) {
  const relative = path.relative(directory, filename);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`路径超出产物目录：${filename}`);
  }
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`不能打包符号链接：${filename}`);
    if (entry.isDirectory()) files.push(...await listFiles(filename));
    else if (entry.isFile()) files.push(filename);
    else throw new Error(`不能打包非常规文件：${filename}`);
  }
  return files;
}

async function validate(files) {
  let bytes = 0;
  let references = 0;
  const verifyReference = async (filename, reference) => {
    if (!reference || reference.startsWith('#') || reference.startsWith('data:')) return;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference)) {
      throw new Error(`资源必须本地化：${path.relative(dist, filename)} → ${reference}`);
    }
    const pathname = decodeURIComponent(reference.split(/[?#]/)[0]);
    if (!pathname) return;
    if (pathname.startsWith('/')) throw new Error(`资源须使用相对路径：${reference}`);
    const target = path.resolve(path.dirname(filename), pathname);
    requireInside(dist, target);
    if (!(await fs.stat(target)).isFile()) throw new Error(`资源不是文件：${reference}`);
    references++;
  };

  for (const filename of files) {
    const size = (await fs.stat(filename)).size;
    const extension = path.extname(filename).toLowerCase();
    bytes += size;
    if (extension === '.html' && size > 5 * megabyte) throw new Error(`HTML 超过 5MB：${filename}`);
    if (/\.(png|jpe?g|webp|gif|bmp|svg|ico)$/i.test(filename)) {
      if (size >= 10 * megabyte) throw new Error(`图片须小于 10MB：${filename}`);
    } else if (extension !== '.html' && size > 100 * megabyte) {
      throw new Error(`单文件超过 100MB：${filename}`);
    }

    if (extension === '.html') {
      const html = await fs.readFile(filename, 'utf8');
      for (const tag of html.matchAll(/<(?:script|link|img|audio|video|source)\b[^>]*>/gi)) {
        for (const attribute of tag[0].matchAll(/\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi)) {
          await verifyReference(filename, attribute[1]);
        }
      }
      for (const script of html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) {
        new Script(script[1], { filename });
      }
    } else if (extension === '.css') {
      const css = await fs.readFile(filename, 'utf8');
      for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
        await verifyReference(filename, match[1].trim());
      }
    } else if (extension === '.js') {
      new Script(await fs.readFile(filename, 'utf8'), { filename });
    }
  }

  // 语言数据和音频由 JavaScript 动态加载，单独核对。
  for (const lang of ['en', 'zh']) await verifyReference(path.join(dist, 'index.html'), `./data/cards-data-${lang}.js`);
  const manifest = JSON.parse(await fs.readFile(path.join(dist, 'manifest.json'), 'utf8'));
  for (const icon of manifest.icons || []) await verifyReference(path.join(dist, 'manifest.json'), icon.src);
  await verifyReference(path.join(dist, 'manifest.json'), manifest.start_url);
  const serviceWorker = await fs.readFile(path.join(dist, 'sw.js'), 'utf8');
  for (const match of serviceWorker.matchAll(/["'](\.\/sound\/[^"']+)["']/g)) {
    await verifyReference(path.join(dist, 'sw.js'), match[1]);
  }

  if (bytes > 1024 * megabyte) throw new Error('未压缩产物超过 1GB，请先精简资源。');
  console.log(`构建完成：dist/，${files.length} 个文件，${(bytes / megabyte).toFixed(2)} MiB`);
  console.log(`校验通过：${references} 项资源引用，脚本语法和单文件大小符合要求。`);
}

try {
  // 清理前验证绝对路径和真实路径，防止误删工作区之外的目录。
  requireInside(root, dist);
  if (path.dirname(dist) !== path.resolve(root) || path.basename(dist) !== 'dist') {
    throw new Error('构建目录必须是工程根目录的 dist/');
  }
  const existing = await fs.lstat(dist).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error('dist 必须是普通目录');
    requireInside(await fs.realpath(root), await fs.realpath(dist));
  }
  // 先核对来源，避免缺失源文件时清空现有产物。
  for (const item of runtimeFiles) {
    const source = path.join(root, item);
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink()) throw new Error(`不能打包符号链接：${source}`);
    if (stat.isDirectory()) await listFiles(source);
  }
  await fs.rm(dist, { recursive: true, force: true });
  await fs.mkdir(dist);
  for (const item of runtimeFiles) await fs.cp(path.join(root, item), path.join(dist, item), { recursive: true });
  await validate(await listFiles(dist));
} catch (error) {
  console.error(`构建失败：${error.message}`);
  process.exitCode = 1;
}
