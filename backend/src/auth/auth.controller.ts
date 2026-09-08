import {
  Controller,
  Post,
  Body,
  ValidationPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
  Request,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dtos/register.dto';
import { LoginDto } from './dtos/login.dto';
import { ChangePasswordDto } from './dtos/change-password.dto';
import { JwtGuard } from './guards/jwt.guard';

class RefreshTokenDto {
  refreshToken: string;
}

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body(ValidationPipe) dto: RegisterDto) {
    const tokens = await this authService.register(dto.email, dto.password, dto.name);
    return {
      message: 'User registered successfully',
      ...tokens,
    };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body(ValidationPipe) dto: LoginDto) {
    const tokens = await this authService.login(dto.email, dto.password);
    return {
      message: 'Login successful',
      ...tokens,
    };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body(ValidationPipe) dto: RefreshTokenDto) {
    try {
      const payload = this authService.verifyRefreshToken(dto.refreshToken);
      const tokens = await this authService.refresh(payload.sub, dto.refreshToken);
      return {
        message: 'Token refreshed',
        ...tokens,
      };
    } catch (error) {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  @Post('change-password')
  @UseGuards(JwtGuard)
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @Request() req,
    @Body(ValidationPipe) dto: ChangePasswordDto,
  ) {
    await this authService.changePassword(req.user.userId, dto.oldPassword, dto.newPassword);
    return { message: 'Password changed successfully' };
  }

  @Post('logout')
  @UseGuards(JwtGuard)
  @HttpCode(HttpStatus.OK)
  async logout() {
    return { message: 'Logged out successfully' };
  }
}