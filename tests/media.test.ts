import { describe, expect, it } from 'vitest';
import { isDiscordMediaUrl, originalMediaUrl, saveLabel } from '../src/shared/media';

describe('saving what people send', () => {
  it('recognizes Discord files and nothing else', () => {
    expect(isDiscordMediaUrl('https://cdn.discordapp.com/attachments/1/2/video.mp4?ex=a&is=b&hm=c')).toBe(true);
    expect(isDiscordMediaUrl('https://media.discordapp.net/attachments/1/2/photo.png?width=400')).toBe(true);
    expect(isDiscordMediaUrl('https://images-ext-1.discordapp.net/external/abc/https/example.com/a.png')).toBe(true);
    expect(isDiscordMediaUrl('https://discord.com/channels/@me')).toBe(false);
    expect(isDiscordMediaUrl('http://cdn.discordapp.com/attachments/1/2/a.png')).toBe(false);
    expect(isDiscordMediaUrl('https://cdn.discordapp.com.evil.example/a.png')).toBe(false);
    expect(isDiscordMediaUrl('https://evilcdn.discordapp.com/a.png')).toBe(false);
    expect(isDiscordMediaUrl('not a url')).toBe(false);
  });
  it('saves the original file, not the resized preview, and keeps the signature', () => {
    expect(originalMediaUrl('https://media.discordapp.net/attachments/1/2/photo.png?ex=6&is=7&hm=8f&width=550&height=309&format=webp&quality=lossless'))
      .toBe('https://cdn.discordapp.com/attachments/1/2/photo.png?ex=6&is=7&hm=8f');
    expect(originalMediaUrl('https://cdn.discordapp.com/attachments/1/2/archive.zip?ex=6&is=7&hm=8f'))
      .toBe('https://cdn.discordapp.com/attachments/1/2/archive.zip?ex=6&is=7&hm=8f');
    // the proxy for external images and emojis stays where it is
    expect(originalMediaUrl('https://media.discordapp.net/stickers/123.png?size=160')).toBe('https://media.discordapp.net/stickers/123.png?size=160');
    expect(originalMediaUrl('https://example.com/a.png')).toBeNull();
  });
  it('labels the menu by kind', () => {
    expect(saveLabel('image')).toBe('Save image');
    expect(saveLabel('video')).toBe('Save video');
    expect(saveLabel('file')).toBe('Save file');
  });
});
