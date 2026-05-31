import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { REQUIRED_MAINNET_ENV_VARS } from '../constants/required-env.constants';

@Injectable()
export class EnvironmentValidatorService {
  constructor(
    private readonly configService: ConfigService,
  ) {}

  validate() {
    const failures: string[] = [];

    for (const key of REQUIRED_MAINNET_ENV_VARS) {
      if (!this.configService.get(key)) {
        failures.push(key);
      }
    }

    return {
      valid: failures.length === 0,
      missing: failures,
    };
  }
}