import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import { Public } from '../../../common/decorators/auth.decorator';
import type { Request, Response } from 'express';
import { ResultData } from '../../../common/utils/result';
import { initTaixuSse, writeTaixuSse } from '../stream/taixu-sse.util';
import { TaixuChatDto, TaixuImageGenerateDto } from './dto';
import { TaixuModalService } from './taixu-modal.service';

@Controller()
export class TaixuModalCompatController {
  constructor(private readonly modalService: TaixuModalService) {}

  @Post('llm/chat')
  /**
   * 兼容路由的 LLM 对话处理。
   * 建立 SSE 连接，流式消费聊天生成的帧数据并实时推送给客户端。
   * @param body - 聊天请求参数
   * @param req - Express 请求对象，用于监听连接关闭事件
   * @param res - Express 响应对象，用于 SSE 推送
   */
  async chat(@Body() body: TaixuChatDto, @Req() req: Request, @Res() res: Response) {
    const abort = initTaixuSse(req, res);
    try {
      for await (const frame of this.modalService.chat(body)) {
        if (abort.signal.aborted) break;
        writeTaixuSse(res, frame.type, frame.payload);
      }
    } finally {
      res.end();
    }
  }

  @Public()
  @Get('image/generate')
  async generate(@Query() query: TaixuImageGenerateDto) {
    const data = await this.modalService.generateImage(query);
    return ResultData.ok(data);
  }
}

