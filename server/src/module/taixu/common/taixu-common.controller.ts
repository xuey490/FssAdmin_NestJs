import { Controller, Get } from '@nestjs/common';
import { Public } from '../../../common/decorators/auth.decorator';
import { ResultData } from '../../../common/utils/result';
import { TaixuCommonService } from './taixu-common.service';

@Controller('api/taixu')
export class TaixuCommonController {
  constructor(private readonly commonService: TaixuCommonService) {}

  @Public()
  @Get('common/info')
  info() {
    return ResultData.ok(this.commonService.getInfo());
  }

  @Public()
  @Get('common/code')
  generateCaptcha() {
    return ResultData.ok(this.commonService.generateCaptcha());
  }
}

