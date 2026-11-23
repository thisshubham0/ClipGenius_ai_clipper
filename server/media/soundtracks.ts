import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SoundtrackId } from '../../src/types/clipgenius';
import { ensureStorageDirs, getMediaFilePath } from '../storage/storageAdapter';

const inFlightSoundtracks = new Map<string, Promise<string | null>>();

/**
 * Generates warm, musical, royalty-free stereo studio backing tracks via FFmpeg
 * procedural synthesis (multi-harmonic chords + bass + rhythmic envelope + lowpass warmth).
 * Cached permanently on disk per trackId so playback and FFmpeg mixing are instantaneous.
 */
function buildFfmpegSoundtrackExpr(trackId: Exclude<SoundtrackId, 'none'>): {
  exprL: string;
  exprR: string;
  audioFilter: string;
} {
  switch (trackId) {
    case 'upbeat_lofi':
      // Warm Rhodes-like maj7 chord progression (C-Am-F-G cycling every 2s) + soft 96 BPM pulse
      return {
        exprL:
          '0.16*sin(2*PI*261.63*t)*if(lt(mod(t,8),2),1,0) + ' +
          '0.12*sin(2*PI*329.63*t)*if(lt(mod(t,8),2),1,0) + ' +
          '0.10*sin(2*PI*392.00*t)*if(lt(mod(t,8),2),1,0) + ' +
          '0.16*sin(2*PI*220.00*t)*if(between(mod(t,8),2,4),1,0) + ' +
          '0.12*sin(2*PI*261.63*t)*if(between(mod(t,8),2,4),1,0) + ' +
          '0.10*sin(2*PI*329.63*t)*if(between(mod(t,8),2,4),1,0) + ' +
          '0.16*sin(2*PI*174.61*t)*if(between(mod(t,8),4,6),1,0) + ' +
          '0.12*sin(2*PI*220.00*t)*if(between(mod(t,8),4,6),1,0) + ' +
          '0.10*sin(2*PI*261.63*t)*if(between(mod(t,8),4,6),1,0) + ' +
          '0.16*sin(2*PI*196.00*t)*if(gte(mod(t,8),6),1,0) + ' +
          '0.12*sin(2*PI*246.94*t)*if(gte(mod(t,8),6),1,0) + ' +
          '0.10*sin(2*PI*293.66*t)*if(gte(mod(t,8),6),1,0) + ' +
          '0.14*sin(2*PI*65.41*t)*exp(-4*mod(t,0.625))',
        exprR:
          '0.15*sin(2*PI*262.10*t)*if(lt(mod(t,8),2),1,0) + ' +
          '0.12*sin(2*PI*330.10*t)*if(lt(mod(t,8),2),1,0) + ' +
          '0.11*sin(2*PI*493.88*t)*if(lt(mod(t,8),2),1,0) + ' +
          '0.15*sin(2*PI*220.40*t)*if(between(mod(t,8),2,4),1,0) + ' +
          '0.12*sin(2*PI*262.00*t)*if(between(mod(t,8),2,4),1,0) + ' +
          '0.11*sin(2*PI*392.00*t)*if(between(mod(t,8),2,4),1,0) + ' +
          '0.15*sin(2*PI*174.90*t)*if(between(mod(t,8),4,6),1,0) + ' +
          '0.12*sin(2*PI*220.30*t)*if(between(mod(t,8),4,6),1,0) + ' +
          '0.11*sin(2*PI*329.63*t)*if(between(mod(t,8),4,6),1,0) + ' +
          '0.15*sin(2*PI*196.30*t)*if(gte(mod(t,8),6),1,0) + ' +
          '0.12*sin(2*PI*247.30*t)*if(gte(mod(t,8),6),1,0) + ' +
          '0.11*sin(2*PI*392.00*t)*if(gte(mod(t,8),6),1,0) + ' +
          '0.14*sin(2*PI*65.41*t)*exp(-4*mod(t,0.625))',
        audioFilter: 'lowpass=f=1800,aecho=0.7:0.6:180:0.28,afade=t=in:st=0:d=0.6,afade=t=out:st=23.2:d=0.8',
      };

    case 'cinematic_ambient':
      // Lush slow-breathing cinematic Dsus2 / Bm7 ambient pad
      return {
        exprL:
          '(0.5+0.5*sin(2*PI*0.125*t))*(0.18*sin(2*PI*146.83*t)+0.14*sin(2*PI*220.00*t)+0.11*sin(2*PI*293.66*t)+0.08*sin(2*PI*329.63*t)) + ' +
          '0.12*sin(2*PI*73.42*t)',
        exprR:
          '(0.5+0.5*cos(2*PI*0.125*t))*(0.18*sin(2*PI*147.20*t)+0.14*sin(2*PI*220.45*t)+0.11*sin(2*PI*329.63*t)+0.08*sin(2*PI*440.00*t)) + ' +
          '0.12*sin(2*PI*73.42*t)',
        audioFilter: 'lowpass=f=1400,aecho=0.8:0.75:320:0.42,afade=t=in:st=0:d=1.0,afade=t=out:st=23.0:d=1.0',
      };

    case 'energetic_synth':
      // Crisp 118 BPM synthwave arpeggio + tight sub pulse
      return {
        exprL:
          '0.18*sin(2*PI*110.00*t)*exp(-5*mod(t,0.5)) + ' +
          '0.14*sin(2*PI*if(lt(mod(t,1),0.25),440,if(lt(mod(t,1),0.5),523.25,if(lt(mod(t,1),0.75),659.25,523.25)))*t)*exp(-6*mod(t,0.25)) + ' +
          '0.09*sin(2*PI*220.00*t)',
        exprR:
          '0.18*sin(2*PI*110.00*t)*exp(-5*mod(t,0.5)) + ' +
          '0.14*sin(2*PI*if(lt(mod(t,1),0.25),329.63,if(lt(mod(t,1),0.5),440,if(lt(mod(t,1),0.75),523.25,659.25)))*t)*exp(-6*mod(t,0.25)) + ' +
          '0.09*sin(2*PI*220.50*t)',
        audioFilter: 'lowpass=f=2400,aecho=0.6:0.5:125:0.25,afade=t=in:st=0:d=0.4,afade=t=out:st=23.4:d=0.6',
      };

    case 'soft_acoustic':
      // Gentle fingerpicked major arpeggio warmth
      return {
        exprL:
          '0.18*sin(2*PI*if(lt(mod(t,2),0.5),196.00,if(lt(mod(t,2),1.0),246.94,if(lt(mod(t,2),1.5),293.66,392.00)))*t)*exp(-3.2*mod(t,0.5)) + ' +
          '0.11*sin(2*PI*98.00*t)*exp(-1.5*mod(t,2))',
        exprR:
          '0.16*sin(2*PI*if(lt(mod(t,2),0.5),293.66,if(lt(mod(t,2),1.0),392.00,if(lt(mod(t,2),1.5),493.88,392.00)))*t)*exp(-3.2*mod(t,0.5)) + ' +
          '0.11*sin(2*PI*98.00*t)*exp(-1.5*mod(t,2))',
        audioFilter: 'lowpass=f=2100,aecho=0.7:0.65:160:0.25,afade=t=in:st=0:d=0.5,afade=t=out:st=23.2:d=0.8',
      };

    case 'dramatic_pulse':
      // Deep minor pulse for bold takes & emotional peaks
      return {
        exprL:
          '0.22*sin(2*PI*82.41*t)*exp(-3.5*mod(t,0.57)) + ' +
          '0.13*sin(2*PI*164.81*t) + 0.10*sin(2*PI*196.00*t) + 0.08*sin(2*PI*246.94*t)*(0.5+0.5*sin(2*PI*0.25*t))',
        exprR:
          '0.22*sin(2*PI*82.41*t)*exp(-3.5*mod(t,0.57)) + ' +
          '0.13*sin(2*PI*165.15*t) + 0.10*sin(2*PI*196.35*t) + 0.08*sin(2*PI*329.63*t)*(0.5+0.5*cos(2*PI*0.25*t))',
        audioFilter: 'lowpass=f=1300,aecho=0.75:0.7:240:0.32,afade=t=in:st=0:d=0.6,afade=t=out:st=23.2:d=0.8',
      };
  }
}

export function isValidSoundtrackId(id: string): id is Exclude<SoundtrackId, 'none'> {
  return (
    id === 'upbeat_lofi' ||
    id === 'cinematic_ambient' ||
    id === 'energetic_synth' ||
    id === 'soft_acoustic' ||
    id === 'dramatic_pulse'
  );
}

export async function ensureSoundtrackFile(
  trackId: SoundtrackId
): Promise<string | null> {
  if (!trackId || trackId === 'none' || !isValidSoundtrackId(trackId)) {
    return null;
  }

  await ensureStorageDirs();
  const outPath = getMediaFilePath(`soundtrack_${trackId}.mp3`);

  try {
    const stat = await fs.stat(outPath);
    if (stat.size > 8192) {
      return outPath;
    }
  } catch {
    // Needs generation
  }

  let pending = inFlightSoundtracks.get(trackId);
  if (!pending) {
    pending = (async () => {
      const { exprL, exprR, audioFilter } = buildFfmpegSoundtrackExpr(trackId);
      const tmpPath = `${outPath}.${process.pid}.${Date.now()}.tmp.mp3`;
      await fs.mkdir(path.dirname(outPath), { recursive: true });

      const ok = await new Promise<boolean>((resolve) => {
        const args = [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          `aevalsrc='${exprL}|${exprR}':s=44100:d=24`,
          '-af',
          audioFilter,
          '-c:a',
          'libmp3lame',
          '-b:a',
          '128k',
          tmpPath,
        ];
        let stderr = '';
        const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on('error', () => resolve(false));
        child.on('close', (code) => {
          if (code !== 0 && stderr.trim()) {
            console.error(`FFmpeg soundtrack synthesis (${trackId}) failed:`, stderr.trim());
          }
          resolve(code === 0);
        });
      });

      if (!ok) {
        await fs.rm(tmpPath, { force: true }).catch(() => {});
        return null;
      }

      try {
        await fs.rename(tmpPath, outPath);
        return outPath;
      } catch {
        await fs.rm(tmpPath, { force: true }).catch(() => {});
        return null;
      }
    })();

    inFlightSoundtracks.set(trackId, pending);
    void pending.finally(() => {
      inFlightSoundtracks.delete(trackId);
    });
  }

  return pending;
}
