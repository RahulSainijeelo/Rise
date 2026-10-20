import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet, Dimensions } from 'react-native';
import { useTheme } from '../theme';
import { NothingText } from '../components/NothingText';
import { restoreDefaultProfile } from '../utils/restoreProfile';
import { RiseLogoAnimation } from '../components/RiseLogoAnimation';

const { width } = Dimensions.get('window');

export const SplashScreen = ({ navigation }: any) => {
    const { theme } = useTheme();

    // Animation Values
    const scale = useRef(new Animated.Value(0.8)).current;
    const opacity = useRef(new Animated.Value(0)).current;
    const textOpacity = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        // 1. Initial Fade In & Scale Up
        Animated.parallel([
            Animated.timing(opacity, {
                toValue: 1,
                duration: 800,
                useNativeDriver: true,
            }),
            Animated.spring(scale, {
                toValue: 1,
                friction: 6,
                tension: 40,
                useNativeDriver: true,
            }),
        ]).start();

        // 2. Text Fade In after delay
        Animated.timing(textOpacity, {
            toValue: 1,
            duration: 800,
            delay: 400,
            useNativeDriver: true,
        }).start();

        // 3. Navigation Logic after animation
        const init = async () => {
            const minWait = new Promise<void>(resolve => setTimeout(() => resolve(), 2000));

            // Hold for the full animation, then reopen into the saved profile. The
            // restore itself (load the real name, log in) lives in one shared helper
            // now, so Splash, App and the widget handler can never drift into
            // restoring differently — the drift that left widget launches on a blank
            // profile. A truthy result means a profile is active (Splash restored it,
            // or App already did during the wait); otherwise there is nothing to
            // reopen into, so go to Login. (P-10)
            await minWait;

            if (await restoreDefaultProfile()) {
                navigation.replace('Main');
            } else {
                navigation.replace('Login');
            }
        };

        init();
    }, []);

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
            <Animated.View style={{ opacity, transform: [{ scale }] }}>
                <RiseLogoAnimation primaryColor={theme.colors.primary} />
            </Animated.View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
});
