import { ReadinessCheckDto } from './readiness-check.dto';

export class ReadinessResponseDto {
  ready: boolean;
  timestamp: string;
  checks: ReadinessCheckDto[];
}