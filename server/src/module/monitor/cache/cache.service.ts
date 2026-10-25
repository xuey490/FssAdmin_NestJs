import { Injectable } from '@nestjs/common';
import { RedisService } from '../../../redis/redis.service';
import { ResultData } from '../../../common/utils/result';

@Injectable()
export class CacheService {
  constructor(private readonly redisService: RedisService) {}

  private get client() {
    return this.redisService.getClient();
  }

  /**
   * 格式化字节大小为可读字符串
   * @param bytes - 字节数值
   * @returns 格式化后的字符串，如 "1.5 MB"
   */
  private formatBytes(bytes: number): string {
    if (bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let value = bytes;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return `${Math.round(value * 100) / 100} ${units[i]}`;
  }

  /**
   * 解析 Redis INFO 命令返回的原始字符串
   * @param rawInfo - Redis INFO 原始响应
   * @returns 解析后的键值对对象，数值型自动转换为 number
   */
  private parseInfo(rawInfo: string): Record<string, any> {
    const result: Record<string, any> = {};
    rawInfo.split('\r\n').forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf(':');
      if (idx === -1) return;
      const key = trimmed.slice(0, idx);
      const value = trimmed.slice(idx + 1);
      if (/^-?\d+(\.\d+)?$/.test(value)) {
        result[key] = value.includes('.') ? parseFloat(value) : parseInt(value, 10);
      } else {
        result[key] = value;
      }
    });
    return result;
  }

  async scanKeys(pattern = '*'): Promise<string[]> {
    return this.client.keys(pattern);
  }

  /**
   * 获取 Redis 浏览器一级目录（按冒号分隔的第一个前缀分组）
   * @param pattern - 键匹配模式，默认为 '*'
   * @returns 前缀分组列表，包含每个前缀下的键数量
   */
  async getFirstLevelKeys(pattern = '*') {
    const keys = await this.scanKeys(pattern);
    const prefixes: Record<string, { key: string; count: number; type: string }> = {};
    for (const key of keys) {
      const prefix = key.split(':')[0];
      if (!prefix) continue;
      if (!prefixes[prefix]) {
        prefixes[prefix] = { key: prefix, count: 0, type: 'prefix' };
      }
      prefixes[prefix].count++;
    }
    return ResultData.ok(Object.values(prefixes));
  }

  /**
   * 获取 Redis 浏览器二级目录（按两级前缀分组）
   * @param prefix - 一级前缀，如 "system"
   * @returns 二级前缀分组列表
   */
  async getSecondLevelKeys(prefix: string) {
    const keys = await this.scanKeys(`${prefix}:*`);
    const secondLevel: Record<string, any> = {};
    for (const key of keys) {
      const parts = key.split(':');
      if (parts.length < 2) continue;
      const secondPrefix = `${parts[0]}:${parts[1]}`;
      if (!secondLevel[secondPrefix]) {
        secondLevel[secondPrefix] = {
          key: secondPrefix,
          fullKey: key,
          count: 0,
          type: parts.length > 2 ? 'prefix' : 'key',
        };
      }
      secondLevel[secondPrefix].count++;
    }
    return ResultData.ok(Object.values(secondLevel));
  }

  /**
   * 获取 Redis 浏览器三级目录（具体键列表，含 TTL 和大小）
   * @param prefix - 二级前缀，如 "system:user"
   * @returns 键详细信息列表
   */
  async getThirdLevelKeys(prefix: string) {
    const keys = await this.scanKeys(`${prefix}:*`);
    const result = [];
    for (const key of keys) {
      result.push({
        key,
        type: 'key',
        ttl: await this.client.ttl(key),
        size: await this.getKeySize(key),
      });
    }
    return ResultData.ok(result);
  }

  /**
   * 根据键类型获取其存储大小（元素数量）
   * @param key - Redis 键名
   * @returns 元素数量
   */
  private async getKeySize(key: string): Promise<number> {
    const type = await this.client.type(key);
    switch (type) {
      case 'string':
        return this.client.strlen(key);
      case 'list':
        return this.client.llen(key);
      case 'set':
        return this.client.scard(key);
      case 'zset':
        return this.client.zcard(key);
      case 'hash':
        return this.client.hlen(key);
      default:
        return 0;
    }
  }

  /**
   * 获取 Redis 浏览器的键详细信息，包含类型、TTL、大小及具体值
   * @param key - Redis 键名
   * @returns 键的完整信息对象
   */
  async getBrowserKeyInfo(key: string) {
    const type = await this.client.type(key);
    const ttl = await this.client.ttl(key);
    const size = await this.getKeySize(key);
    const info: any = { key, type, ttl, size, value: null };

    switch (type) {
      case 'string': {
        const value = await this.client.get(key);
        info.value = value && value.length > 1000 ? `${value.slice(0, 1000)}...` : value;
        break;
      }
      case 'list':
        info.value = await this.client.lrange(key, 0, 99);
        break;
      case 'set':
        info.value = await this.client.smembers(key);
        break;
      case 'zset':
        info.value = await this.client.zrange(key, 0, '99');
        break;
      case 'hash':
        info.value = await this.client.hgetall(key);
        break;
    }
    return ResultData.ok(info);
  }

  async deleteBrowserKey(key: string) {
    const deleted = await this.client.del(key);
    return ResultData.ok({ deleted: deleted > 0 ? 1 : 0 });
  }

  /**
   * 根据匹配模式批量删除 Redis 键
   * @param pattern - 键匹配模式
   * @returns 删除结果，包含删除数量
   */
  async deleteByPattern(pattern: string) {
    const keys = await this.scanKeys(pattern);
    if (!keys.length) {
      return ResultData.ok({ deleted: 0 });
    }
    const deleted = await this.client.del(...keys);
    return ResultData.ok({ deleted });
  }

  /**
   * Redis 监控（对齐 PHP getFullInfo 结构）
   */
  async getInfo() {
    try {
      await this.client.ping();
    } catch {
      return ResultData.ok(this.emptyFullInfo('Redis连接失败'));
    }

    try {
      const rawInfo = await this.client.info();
      const info = this.parseInfo(rawInfo);
      const uptimeInSeconds = Number(info.uptime_in_seconds || 0);
      const usedMemoryBytes = Number(info.used_memory || 0);

      const variable = {
        used_memory: usedMemoryBytes,
        used_memory_peak: Number(info.used_memory_peak || 0),
        used_memory_rss: Number(info.used_memory_rss || 0),
        mem_fragmentation_ratio: Number(info.mem_fragmentation_ratio || 0),
        keyspace_hits: Number(info.keyspace_hits || 0),
        keyspace_misses: Number(info.keyspace_misses || 0),
        expired_keys: Number(info.expired_keys || 0),
        evicted_keys: Number(info.evicted_keys || 0),
        instantaneous_ops_per_sec: Number(info.instantaneous_ops_per_sec || 0),
        instantaneous_input_kbps: Number(info.instantaneous_input_kbps || 0),
        instantaneous_output_kbps: Number(info.instantaneous_output_kbps || 0),
        total_commands_processed: Number(info.total_commands_processed || 0),
        redis_version: info.redis_version || '',
        redis_mode: info.redis_mode || '',
        os: info.os || '',
        arch_bits: Number(info.arch_bits || 0),
        mem_allocator: info.mem_allocator || '',
        role: info.role || '',
        tcp_port: Number(info.tcp_port || 0),
        aof_enabled: Number(info.aof_enabled || 0),
        rdb_changes_since_last_save: Number(info.rdb_changes_since_last_save || 0),
        total_connections_received: Number(info.total_connections_received || 0),
      };

      return ResultData.ok({
        uptime_in_seconds: uptimeInSeconds,
        uptime_in_days: Math.floor(uptimeInSeconds / 86400),
        connected_clients: Number(info.connected_clients || 0),
        used_memory: this.formatBytes(usedMemoryBytes),
        variable,
      });
    } catch (e: any) {
      return ResultData.ok(this.emptyFullInfo(`Redis数据获取失败: ${e?.message || e}`));
    }
  }

  /**
   * 获取空的 Redis 监控信息结构（用于异常时返回）
   * @param message - 错误提示信息
   * @returns 填充默认值的监控信息对象
   */
  private emptyFullInfo(message: string) {
    return {
      error: true,
      error_message: message,
      uptime_in_seconds: 0,
      uptime_in_days: 0,
      connected_clients: 0,
      used_memory: '0 B',
      variable: {
        used_memory: 0,
        used_memory_peak: 0,
        used_memory_rss: 0,
        mem_fragmentation_ratio: 0,
        keyspace_hits: 0,
        keyspace_misses: 0,
        expired_keys: 0,
        evicted_keys: 0,
        instantaneous_ops_per_sec: 0,
        instantaneous_input_kbps: 0,
        instantaneous_output_kbps: 0,
        total_commands_processed: 0,
        redis_version: '',
        redis_mode: '',
        os: '',
        arch_bits: 0,
        mem_allocator: '',
        role: '',
        tcp_port: 0,
        aof_enabled: 0,
        rdb_changes_since_last_save: 0,
        total_connections_received: 0,
      },
    };
  }
}
