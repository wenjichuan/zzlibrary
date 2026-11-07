/** 远端存储抽象：同步引擎唯一依赖的传输接口。
 * 实现仅需支持「按键读写 + 存在探测」——WebDAV/S3/本地目录皆可；
 * 目录列表（PROPFIND/ListObjects）永远不需要（两级索引代替列目录）。
 *
 * 语义约定：
 * - get* 在对象不存在时返回 null（404）；
 * - put* 幂等（同键重写同内容无害：blob 内容寻址、清单确定性序列化）；
 * - head 只回答存在性。 */

export interface RemoteStore {
  /** 探测连接与读写能力（写入探针对象后读取并删除）。抛错=不可用。 */
  probe(): Promise<void>;
  getText(path: string): Promise<string | null>;
  putText(path: string, text: string): Promise<void>;
  getBytes(path: string): Promise<Uint8Array | null>;
  /** 按字节区间读取（闭区间 [start, end]；流式代理/前缀取回用）；null = 该远端不支持区间读，调用方回退整取 */
  getBytesRange?(path: string, start: number, end: number): Promise<Uint8Array | null>;
  putBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** 流式写入（大 blob 逐段上传不整读进内存；S3 实现=multipart）。实现方保证消费或取消流。 */
  putStream?(path: string, source: ReadableStream<Uint8Array>): Promise<void>;
  head(path: string): Promise<boolean>;
  remove?(path: string): Promise<void>;
}

export class SyncTransportError extends Error {
  constructor(
    message: string,
    public readonly path: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SyncTransportError";
  }
}
