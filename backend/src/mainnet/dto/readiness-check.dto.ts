export class ReadinessCheckDto {
  name: string;
  status: 'pass' | 'fail';
  message?: string;
}