import { Controller, Get } from '@nestjs/common';
import { ReadinessService } from './readiness.service';

@Controller('ready')
export class ReadinessController {
  constructor(private readonly service: ReadinessService) {}

  @Get()
  check() {
    return this.service.check();
  }
}