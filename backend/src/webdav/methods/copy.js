/**
 * 处理WebDAV COPY请求
 * 用于复制文件和目录
 */
import { findMountPointByPath, normalizeS3SubPath, parseDestinationPath, updateMountLastUsed, checkDirectoryExists } from "../utils/webdavUtils.js";
import { createS3Client } from "../../utils/s3Utils.js";
import { CopyObjectCommand, ListObjectsV2Command, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { clearCacheAfterWebDAVOperation } from "../utils/cacheUtils.js";
import { handleWebDAVError } from "../utils/errorUtils.js";

/**
 * 处理COPY请求
 * @param {Object} c - Hono上下文
 * @param {string} path - 请求路径
 * @param {string} userId - 用户ID
 * @param {string} userType - 用户类型 (admin 或 apiKey)
 * @param {D1Database} db - D1数据库实例
 */
export async function handleCopy(c, path, userId, userType, db) {
  try {
    // 使用统一函数查找源路径的挂载点 - COPY使用操作权限
    const sourceMountResult = await findMountPointByPath(db, path, userId, userType, "operation");

    // 处理错误情况
    if (sourceMountResult.error) {
      return new Response(sourceMountResult.error.message, {
        status: sourceMountResult.error.status,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // 获取目标路径
    const destination = c.req.headers.get("Destination");
    const destPath = parseDestinationPath(destination);

    if (!destPath) {
      return new Response("缺少目标路径头", {
        status: 400,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // 检查源路径和目标路径是否相同
    if (path === destPath) {
      return new Response("源路径和目标路径相同", {
        status: 400,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // 查找目标路径的挂载点 - COPY使用操作权限
    const destMountResult = await findMountPointByPath(db, destPath, userId, userType, "operation");

    // 如果目标路径是根目录，则返回错误
    if (destMountResult.isRoot) {
      return new Response("无法复制到根目录", {
        status: 403,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // 如果没有找到目标挂载点，返回错误
    if (destMountResult.error) {
      return new Response(destMountResult.error.message, {
        status: destMountResult.error.status,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // 确保源和目标在同一个挂载点
    if (sourceMountResult.mount.id !== destMountResult.mount.id) {
      return new Response("不支持在不同挂载点之间复制", {
        status: 502,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // 获取深度头，用于确定是否递归复制目录
    const depth = c.req.headers.get("Depth") || "infinity";
    if (depth !== "0" && depth !== "infinity") {
      return new Response("无效的深度头", {
        status: 400,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const { mount, subPath: sourceSubPath } = sourceMountResult;
    const { subPath: destSubPath } = destMountResult;

    // 获取挂载点对应的S3配置
    const s3Config = await db.prepare("SELECT * FROM s3_configs WHERE id = ?").bind(mount.storage_config_id).first();

    if (!s3Config) {
      return new Response("存储配置不存在", { status: 404 });
    }

    // 创建S3客户端
    const s3Client = await createS3Client(s3Config, c.env.ENCRYPTION_SECRET);

    // 判断是文件还是目录
    const isDirectory = path.endsWith("/");

    // 规范化S3子路径
    const sourceS3SubPath = normalizeS3SubPath(sourceSubPath, s3Config, isDirectory);
    const destS3SubPath = normalizeS3SubPath(destSubPath, s3Config, isDirectory);

    // 获取Overwrite头，判断是否允许覆盖
    const overwrite = c.req.headers.get("Overwrite");
    const allowOverwrite = overwrite !== "F";

    // 检查目标父目录是否存在
    if (destS3SubPath.includes("/")) {
      const destParentPath = destS3SubPath.substring(0, destS3SubPath.lastIndexOf("/") + 1);
      const parentExists = await checkDirectoryExists(s3Client, s3Config.bucket_name, destParentPath);

      if (!parentExists) {
        console.log(`COPY请求: 目标父目录 ${destParentPath} 不存在，正在自动创建...`);

        try {
          // 创建一个空对象作为目录标记
          const createDirParams = {
            Bucket: s3Config.bucket_name,
            Key: destParentPath,
            Body: "", // 空内容
            ContentType: "application/x-directory", // 目录内容类型
          };

          const createDirCommand = new PutObjectCommand(createDirParams);
          await s3Client.send(createDirCommand);
          console.log(`COPY请求: 已成功创建目标父目录 ${destParentPath}`);
        } catch (dirError) {
          console.error(`COPY请求: 创建目标父目录 ${destParentPath} 失败:`, dirError);
          // 记录错误但继续尝试，某些S3实现可能不需要显式目录对象
        }
      }
    }

    // 检查目标是否已存在
    let destExists = false;
    try {
      const headParams = {
        Bucket: s3Config.bucket_name,
        Key: destS3SubPath,
      };

      const headCommand = new HeadObjectCommand(headParams);
      await s3Client.send(headCommand);
      destExists = true;
    } catch (error) {
      // 如果目标不存在，继续处理
      if (!(error.$metadata && error.$metadata.httpStatusCode === 404)) {
        throw error;
      }
    }

    // 如果目标存在且不允许覆盖，返回错误
    if (destExists && !allowOverwrite) {
      return new Response("目标已存在且不允许覆盖", {
        status: 412, // Precondition Failed
        headers: { "Content-Type": "text/plain" },
      });
    }

    // 处理目录复制
    if (isDirectory) {
      // 如果深度为0，只复制目录本身
      if (depth === "0") {
        // 在S3中创建目标目录
        const putParams = {
          Bucket: s3Config.bucket_name,
          Key: destS3SubPath,
          ContentLength: 0,
          Body: "",
        };

        const putCommand = new PutObjectCommand(putParams);
        await s3Client.send(putCommand);

        // 清理缓存 - 只复制目录本身
        await clearCacheAfterWebDAVOperation(db, destS3SubPath, s3Config, true, mount.id);
      } else {
        // 深度为infinity，递归复制目录内容
        // 列出目录中的所有对象
        const objects = [];
        let continuationToken = undefined;

        do {
          const listParams = {
            Bucket: s3Config.bucket_name,
            Prefix: sourceS3SubPath,
            ContinuationToken: continuationToken,
          };

          const listCommand = new ListObjectsV2Command(listParams);
          const listResponse = await s3Client.send(listCommand);

          if (listResponse.Contents) {
            objects.push(...listResponse.Contents);
          }

          continuationToken = listResponse.NextContinuationToken;
        } while (continuationToken);

        // 检查源目录是否存在
        if (objects.length === 0) {
          // 尝试检查空目录是否存在
          try {
            const headParams = {
              Bucket: s3Config.bucket_name,
              Key: sourceS3SubPath,
            };

            const headCommand = new HeadObjectCommand(headParams);
            await s3Client.send(headCommand);

            // 如果目录存在但为空，创建一个空目录
            const putParams = {
              Bucket: s3Config.bucket_name,
              Key: destS3SubPath,
              ContentLength: 0,
              Body: "",
            };

            const putCommand = new PutObjectCommand(putParams);
            await s3Client.send(putCommand);

            // 清理缓存 - 复制空目录
            await clearCacheAfterWebDAVOperation(db, destS3SubPath, s3Config, true, mount.id);
          } catch (error) {
            if (error.$metadata && error.$metadata.httpStatusCode === 404) {
              return new Response("源目录不存在", { status: 404 });
            }
            throw error;
          }
        } else {
          // 复制目录下的所有对象
          for (const object of objects) {
            // 计算相对于源目录的路径
            const relativePath = object.Key.substring(sourceS3SubPath.length);
            const newKey = destS3SubPath + relativePath;

            // 复制对象到新位置
            const copyParams = {
              Bucket: s3Config.bucket_name,
              CopySource: encodeURIComponent(`${s3Config.bucket_name}/${object.Key}`),
              Key: newKey,
            };

            const copyCommand = new CopyObjectCommand(copyParams);
            await s3Client.send(copyCommand);
          }

          // 更新目标父目录的修改时间
          const rootPrefix = s3Config.root_prefix ? (s3Config.root_prefix.endsWith("/") ? s3Config.root_prefix : s3Config.root_prefix + "/") : "";
          const { updateParentDirectoriesModifiedTime } = await import("../../services/fsService.js");
          await updateParentDirectoriesModifiedTime(s3Client, s3Config.bucket_name, destS3SubPath, rootPrefix);

          // 清理缓存 - 目录复制完成
          await clearCacheAfterWebDAVOperation(db, destS3SubPath, s3Config, true, mount.id);
        }
      }
    } else {
      // 处理文件复制
      // 检查源文件是否存在
      try {
        const headParams = {
          Bucket: s3Config.bucket_name,
          Key: sourceS3SubPath,
        };

        const headCommand = new HeadObjectCommand(headParams);
        await s3Client.send(headCommand);
      } catch (error) {
        if (error.$metadata && error.$metadata.httpStatusCode === 404) {
          return new Response("源文件不存在", { status: 404 });
        }
        throw error;
      }

      // 复制文件到新位置
      const copyParams = {
        Bucket: s3Config.bucket_name,
        CopySource: encodeURIComponent(`${s3Config.bucket_name}/${sourceS3SubPath}`),
        Key: destS3SubPath,
      };

      const copyCommand = new CopyObjectCommand(copyParams);
      await s3Client.send(copyCommand);

      // 更新目标父目录的修改时间
      const rootPrefix = s3Config.root_prefix ? (s3Config.root_prefix.endsWith("/") ? s3Config.root_prefix : s3Config.root_prefix + "/") : "";
      const { updateParentDirectoriesModifiedTime } = await import("../../services/fsService.js");
      await updateParentDirectoriesModifiedTime(s3Client, s3Config.bucket_name, destS3SubPath, rootPrefix);

      // 清理缓存 - 文件复制后清理目标路径的缓存
      await clearCacheAfterWebDAVOperation(db, destS3SubPath, s3Config, false, mount.id);
    }

    // 更新挂载点的最后使用时间
    await updateMountLastUsed(db, mount.id);

    // 返回成功响应
    return new Response(null, {
      status: 201, // Created
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": "0",
      },
    });
  } catch (error) {
    // 使用统一的错误处理
    return handleWebDAVError("COPY", error, false, false);
  }
}
