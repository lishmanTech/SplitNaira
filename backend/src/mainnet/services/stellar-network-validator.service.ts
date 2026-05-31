import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class StellarNetworkValidatorService {
  constructor(
    private readonly configService: ConfigService,
  ) {}

  validate() {
    const network =
      this.configService.get<string>('STELLAR_NETWORK');

    const horizon =
      this.configService.get<string>('HORIZON_URL');

    const isMainnet =
      network === 'mainnet' &&
      horizon?.includes('stellar.org');

    return {
      valid: isMainnet,
      network,
      horizon,
    };
  }
}