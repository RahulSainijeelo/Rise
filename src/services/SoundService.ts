import SoundPlayer from 'react-native-sound-player';

export const SoundService = {
    playSound: (type: 'complete' | 'delete' | 'error' | 'timer_end') => {
        try {
            // Note: These files need to be added to android/app/src/main/res/raw
            // and ios/Rise/Resources
            switch (type) {
                case 'complete':
                    SoundPlayer.playSoundFile('complete', 'mp3');
                    break;
                case 'delete':
                    SoundPlayer.playSoundFile('delete', 'mp3');
                    break;
                case 'error':
                    SoundPlayer.playSoundFile('error', 'mp3');
                    break;
                case 'timer_end':
                    SoundPlayer.playSoundFile('timer_end', 'mp3');
                    break;
            }
        } catch (e) {
            console.log(`Cannot play the sound file`, e);
        }
    }
};
